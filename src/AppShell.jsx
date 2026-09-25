import wirdWhiteLogo from './assets/wird-white.png';

/**
 * Shell de workspace: sidebar navy + main canvas.
 * Las vistas siguen montadas por el padre; esto solo cambia el chrome.
 */
export default function AppShell({
  navItems = [],
  currentView,
  onNavigate,
  statusLabel = '',
  children,
}) {
  return (
    <div className="App min-h-screen bg-canvas font-sans text-ink antialiased">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[248px_1fr]">
        <aside className="bg-navy text-surface flex flex-col px-3.5 py-4 gap-1.5 lg:sticky lg:top-0 lg:self-start lg:h-screen lg:overflow-y-auto">
          <div className="px-2 pb-3.5 pt-1">
            <img src={wirdWhiteLogo} alt="Wird" className="h-5 block" />
          </div>

          <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-white/35 mb-1">
            Módulos
          </p>

          <nav className="flex flex-col gap-0.5 flex-1">
            {navItems.map(item => {
              const active = currentView === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  className={`text-left rounded-xl px-3 py-2.5 text-sm transition-colors focus:outline-none ${
                    active
                      ? 'bg-accent text-navy font-semibold'
                      : 'text-white/75 hover:bg-white/5 hover:text-white font-medium'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {item.label}
                    {item.badge && (
                      <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none text-white">
                        {item.badge}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>

          {statusLabel ? (
            <div className="mx-1 mt-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-accent">Análisis activo</p>
              <p className="text-xs text-white/70 mt-1 leading-snug">{statusLabel}</p>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              localStorage.removeItem('auth');
              window.location.href = '/login';
            }}
            className="mt-2 mx-1 rounded-xl px-3 py-2.5 text-sm font-medium text-white/55 hover:bg-white/5 hover:text-rose-300 text-left transition-colors focus:outline-none"
          >
            Logout
          </button>
        </aside>

        <div className="flex flex-col min-w-0 min-h-screen">
          <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur px-5 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Workspace</p>
              <p className="text-sm font-semibold text-ink truncate">
                {navItems.find(i => i.id === currentView)?.label || 'Wird'}
              </p>
            </div>
          </header>
          <main className="flex-1 p-5 lg:p-6 max-w-[1440px] w-full mx-auto">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
