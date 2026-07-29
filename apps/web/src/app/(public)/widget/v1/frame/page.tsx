import { WidgetApp } from '@/components/widget/widget-app';

/**
 * The iframe target — both frames the loader injects point here, switched
 * by `?view=`.
 *
 * `v1` in the path matches `public/widget/v1/loader.js`: the snippet on a
 * customer's site references both, and once pasted it may never be touched
 * again. Neither path can ever change meaning.
 *
 * The key comes from the query string rather than a header because an
 * `<iframe src>` cannot set headers. That is fine — the widget key is
 * public by design (it is in the customer's page source) and authorises
 * nothing on its own; every conversation-touching call additionally
 * requires a signed session token.
 */
export default async function WidgetFramePage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; view?: string }>;
}) {
  const { key, view } = await searchParams;

  if (!key) {
    // Rendered rather than thrown: this frame is inside somebody's website,
    // and a Next error page there is both ugly and confusing. A quiet line
    // aimed at the developer who mis-pasted the snippet is more useful.
    return (
      <div className="flex h-screen items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Chat is not configured for this site.
      </div>
    );
  }

  const isLauncher = view === 'launcher';

  return (
    <>
      {isLauncher && (
        <style>{`
          html, body, #__next, body > div {
            margin: 0 !important;
            padding: 0 !important;
            width: 100% !important;
            height: 100% !important;
            background: transparent !important;
            background-color: transparent !important;
            overflow: hidden !important;
          }
        `}</style>
      )}
      <div
        style={{
          width: '100%',
          height: '100%',
          background: 'transparent',
          overflow: 'hidden',
          userSelect: 'none',
        }}
      >
        <WidgetApp
          widgetKey={key}
          // Anything other than an explicit `launcher` renders the panel, so a
          // mangled or missing param degrades to the useful view rather than a
          // blank 56px square.
          view={isLauncher ? 'launcher' : 'panel'}
        />
      </div>
    </>
  );
}
