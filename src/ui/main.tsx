import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

// errors are logged, and reported (once per kind a day) to the reports folder for fixing
window.addEventListener('error', (e) => {
  try {
    const g = (window as any).gcc;
    g?.log('error: ' + (e.error?.stack || e.message));
    if (e.error || e.message) g?.reportCrash('window', String(e.error?.message || e.message || ''), String(e.error?.stack || (e.filename ? e.filename + ':' + e.lineno : '')));
  } catch { /* ignore */ }
});
// (the same failure many times at once - every page part waiting on an engine that went down -
// is logged once with a count, not 60 times)
let lastRej = { msg: '', at: 0, n: 0 };
window.addEventListener('unhandledrejection', (e) => {
  try {
    const g = (window as any).gcc;
    const msg = String(e.reason?.message || e.reason || '');
    const now = Date.now();
    if (msg === lastRej.msg && now - lastRej.at < 5000) { lastRej.n++; lastRej.at = now; return; }
    if (lastRej.n) g?.log(`(the rejection before: ${lastRej.n} more times)`);
    lastRej = { msg, at: now, n: 0 };
    g?.log('rejection: ' + (e.reason?.stack || e.reason));
    // a drawing / editing engine going down is reported once, as that engine's crash
    if (e.reason?.engineDown) return;
    g?.reportCrash('window (promise)', msg, String(e.reason?.stack || ''));
  } catch { /* ignore */ }
});
/** a drawing error anywhere in the window: a plain page with a way back, not a blank window */
class Guard extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) {
    try {
      const g = (window as any).gcc;
      g?.log('render error: ' + (err?.stack || err));
      g?.reportCrash('window (drawing)', String(err?.message || err), String(err?.stack || ''));
    } catch { /* ignore */ }
  }
  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 640, margin: '10vh auto', font: '14px/1.5 system-ui, sans-serif' }}>
        <h2 style={{ margin: '0 0 8px' }}>Something went wrong in this window</h2>
        <p>The error was logged and reported. Reload the window to carry on – files with unsaved changes are offered back from their recovery copies.</p>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.7, maxHeight: 160, overflow: 'auto' }}>{String(err.message || err)}</pre>
        <button style={{ padding: '6px 16px', fontSize: 14 }} onClick={() => location.reload()}>Reload the window</button>
      </div>
    );
  }
}
createRoot(document.getElementById('root')!).render(<Guard><App /></Guard>);
