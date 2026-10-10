import { render } from 'preact';
import '../../ui/tokens.css';
import '../../ui/kit/kit.css';
import { initTheme } from '../../ui/kit/kit';
import { OnboardingApp } from '../../ui/onboarding/OnboardingApp';

initTheme();
render(<OnboardingApp />, document.getElementById('app')!);
