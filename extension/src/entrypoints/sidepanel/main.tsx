import { render } from 'preact';
import '../../ui/tokens.css';
import '../../ui/kit/kit.css';
import { initTheme } from '../../ui/kit/kit';
import { SidePanelApp } from '../../ui/sidepanel/SidePanelApp';

initTheme();
render(<SidePanelApp />, document.getElementById('app')!);
