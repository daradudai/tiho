import { render } from 'preact';
import '../../ui/tokens.css';
import '../../ui/kit/kit.css';
import { initTheme } from '../../ui/kit/kit';
import { PopupApp } from '../../ui/popup/PopupApp';

initTheme();
render(<PopupApp />, document.getElementById('app')!);
