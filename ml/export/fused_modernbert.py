"""ModernBERT sequence classifier re-expressed with ONNX Runtime contrib ops
(com.microsoft RotaryEmbedding + MultiHeadAttention) for export.

Why: the stock HF graph is ~1400 nodes (rotary = 14 elementwise ops per layer,
mask construction, shape plumbing). On the WebGPU EP every node is a kernel
dispatch, so per-call overhead dominated (≈25-30 ms per forward at batch 1 on an
RTX 3090). With fused attention a layer is ~14 nodes.

Same weights, same math (validated against the HF model in export_onnx.py).
Assumes max_len <= local_attention/2 so sliding-window layers see every token
(mmBERT: local_attention 128 -> window ±64 >= max_len 64): sliding == global.
"""

from __future__ import annotations

import torch
from torch import nn


class _Rotary(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x, pos, cos_cache, sin_cache, num_heads: int):  # noqa: ARG004
        b, s, d = x.shape
        h = d // num_heads
        xh = x.view(b, s, num_heads, h)
        cos = cos_cache[:s].view(1, s, 1, h // 2)
        sin = sin_cache[:s].view(1, s, 1, h // 2)
        x1, x2 = xh[..., : h // 2], xh[..., h // 2:]
        out = torch.cat([x1 * cos - x2 * sin, x2 * cos + x1 * sin], dim=-1)
        return out.reshape(b, s, d)

    @staticmethod
    def symbolic(g, x, pos, cos_cache, sin_cache, num_heads):
        return g.op("com.microsoft::RotaryEmbedding", x, pos, cos_cache, sin_cache,
                    interleaved_i=0, num_heads_i=num_heads)


class _MHA(torch.autograd.Function):
    @staticmethod
    def forward(ctx, q, k, v, attn_bias, num_heads: int):  # noqa: ARG004
        b, s, d = q.shape
        h = d // num_heads
        qh = q.view(b, s, num_heads, h).transpose(1, 2)
        kh = k.view(b, s, num_heads, h).transpose(1, 2)
        vh = v.view(b, s, num_heads, h).transpose(1, 2)
        scores = (qh @ kh.transpose(-1, -2)) * (h ** -0.5) + attn_bias
        out = torch.softmax(scores, dim=-1) @ vh
        return out.transpose(1, 2).reshape(b, s, d)

    @staticmethod
    def symbolic(g, q, k, v, attn_bias, num_heads):
        # inputs 3 (bias) and 4 (key_padding_mask) are empty; fixed up after export
        return g.op("com.microsoft::MultiHeadAttention", q, k, v, attn_bias, num_heads_i=num_heads)


def fix_mha_inputs(model_proto) -> int:
    """MHA symbolic emits (q, k, v, attention_bias); move attention_bias to input #5."""
    n = 0
    for node in model_proto.graph.node:
        if node.op_type == "MultiHeadAttention" and node.domain == "com.microsoft" and len(node.input) == 4:
            q, k, v, ab = list(node.input)
            del node.input[:]
            node.input.extend([q, k, v, "", "", ab])
            n += 1
    return n


class FusedModernBertForSequenceClassification(nn.Module):
    def __init__(self, hf_model, max_len: int):
        super().__init__()
        cfg = hf_model.config
        assert cfg.classifier_pooling in ("mean", "cls"), cfg.classifier_pooling
        window = getattr(cfg, "local_attention", 10**9) // 2
        if max_len > window:
            raise ValueError(f"max_len {max_len} > sliding half-window {window}: fused export would ignore the window")
        self.m = hf_model
        self.num_heads = cfg.num_attention_heads
        self.head_dim = cfg.hidden_size // cfg.num_attention_heads
        self.pooling = cfg.classifier_pooling
        layer_types = getattr(cfg, "layer_types", None) or ["full_attention"] * cfg.num_hidden_layers
        self.layer_types = list(layer_types)
        # rotary caches per layer type: [max_len, head_dim/2]
        pos = torch.arange(max_len).unsqueeze(0)
        dummy = torch.zeros(1, max_len, self.head_dim)
        rot = hf_model.model.rotary_emb
        for lt in sorted(set(self.layer_types)):
            try:
                cos, sin = rot(dummy, pos, lt)
            except TypeError:
                cos, sin = rot(dummy, pos)
            half = self.head_dim // 2
            self.register_buffer(f"cos_{lt}", cos[0, :, :half].contiguous().float(), persistent=False)
            self.register_buffer(f"sin_{lt}", sin[0, :, :half].contiguous().float(), persistent=False)
        self.register_buffer("pos0", torch.zeros(1, dtype=torch.int64), persistent=False)

    def forward(self, input_ids, attention_mask):
        mm = self.m.model
        h = mm.embeddings(input_ids=input_ids)
        maskf = attention_mask.to(h.dtype)
        # additive key-padding bias [B, 1, S, S]
        bias = ((1.0 - maskf) * -10000.0)[:, None, None, :]
        bias = bias.expand(-1, -1, input_ids.shape[1], -1)
        d = h.shape[-1]
        for layer, lt in zip(mm.layers, self.layer_types):
            a = layer.attn_norm(h)
            qkv = layer.attn.Wqkv(a)
            q, k, v = qkv.split(d, dim=-1)
            cos, sin = getattr(self, f"cos_{lt}"), getattr(self, f"sin_{lt}")
            q = _Rotary.apply(q, self.pos0, cos, sin, self.num_heads)
            k = _Rotary.apply(k, self.pos0, cos, sin, self.num_heads)
            o = _MHA.apply(q, k, v, bias, self.num_heads)
            h = h + layer.attn.Wo(o)
            x = layer.mlp.Wi(layer.mlp_norm(h))
            inp, gate = x.chunk(2, dim=-1)
            h = h + layer.mlp.Wo(layer.mlp.act(inp) * gate)
        h = mm.final_norm(h)
        if self.pooling == "mean":
            pooled = (h * maskf.unsqueeze(-1)).sum(dim=1) / maskf.sum(dim=1, keepdim=True)
        else:
            pooled = h[:, 0]
        return self.m.classifier(self.m.drop(self.m.head(pooled)))
