import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-700.css';
import './styles/base.css';
import './styles/app.css';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;

if (params.has('rig')) {
  const { startRigViewer } = await import('./debug/rig-viewer.ts');
  await startRigViewer(app);
} else {
  const { startApp } = await import('./app/app.ts');
  await startApp(app);
}
