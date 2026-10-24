/*
 * Browser half of dsh-weapp-loop: a right-sidebar panel showing the IDE
 * state, the last preview QR code, and the structured compile errors.
 * Reads /dsh-weapp-loop/config (registered by the host half) and pushes a
 * health ping so the host knows the renderer is alive.
 */
window.__ModuleLoader__.load({
  id: 'dsh-weapp-loop',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'dsh-weapp-loop';
    const PANEL_KIND = 'dsh-weapp-loop';
    const CONFIG_PATH = '/dsh-weapp-loop/config';

    const card = (style) => Object.assign({
      background: 'var(--dsw-alias-surface-secondary, #181818)',
      border: '1px solid var(--dsw-alias-border, #ffffff18)',
      borderRadius: 8,
      padding: 10,
      color: 'var(--dsw-alias-label-primary, #eee)',
    }, style || {});

    function useConfig() {
      const [config, setConfig] = React.useState(null);
      React.useEffect(() => {
        let disposed = false;
        const read = async () => {
          try {
            const response = await fetch(CONFIG_PATH, { cache: 'no-store' });
            if (!response.ok) return;
            const next = await response.json();
            if (!disposed) setConfig(next);
          } catch (_) { /* host half not mounted yet */ }
        };
        void read();
        const timer = setInterval(read, 3000);
        return () => { disposed = true; clearInterval(timer); };
      }, []);
      return config;
    }

    function Dot({ on }) {
      return h('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: on ? '#3fb950' : '#8b949e', marginRight: 6, verticalAlign: 'middle',
        },
      });
    }

    function ErrorRow({ item }) {
      const where = [item.file, item.line, item.column].filter((v) => v !== null && v !== undefined).join(':');
      const color = item.kind === 'error' ? '#f85149' : item.kind === 'warning' ? '#d29922' : '#8b949e';
      return h('div', { style: { padding: '6px 8px', borderLeft: `3px solid ${color}`, marginBottom: 6, fontSize: 12, lineHeight: 1.5 } },
        h('div', { style: { opacity: 0.75, fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: 11 } }, where || '—'),
        h('div', null, item.message),
      );
    }

    function Panel() {
      const config = useConfig();
      if (!config) {
        return h('div', { style: { padding: 16, opacity: 0.7 } }, '正在连接宿主…');
      }
      const ide = config.ide || {};
      const errors = Array.isArray(config.lastErrors) ? config.lastErrors : [];
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, height: '100%', overflow: 'auto' } },
        h('div', { style: card() },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '微信开发者工具'),
          h('div', { style: { fontSize: 12, lineHeight: 1.9 } },
            h('div', null, h(Dot, { on: ide.installed }), ide.installed ? '已安装' : '未检测到安装'),
            h('div', null, h(Dot, { on: !!config.readySince }), config.readySince ? `已就绪（${config.readySince}）` : '未就绪（需登录并打开项目）'),
            config.projectPath ? h('div', { style: { opacity: 0.7, wordBreak: 'break-all', fontSize: 11 } }, config.projectPath) : null,
          ),
        ),
        config.lastQr
          ? h('div', { style: card({ textAlign: 'center' }) },
              h('div', { style: { fontSize: 12, opacity: 0.75, marginBottom: 8 } }, config.lastPreviewAt ? `预览于 ${config.lastPreviewAt}` : '最近预览'),
              h('img', { src: config.lastQr, alt: '小程序预览二维码', style: { maxWidth: '100%', background: '#fff', borderRadius: 6 } }),
            )
          : h('div', { style: card({ textAlign: 'center', opacity: 0.7, fontSize: 12 }) }, '还没有预览。让 agent 调用 weapp_preview，二维码会出现在这里。'),
        errors.length
          ? h('div', { style: card() },
              h('div', { style: { fontWeight: 600, marginBottom: 8 } }, `编译问题（${errors.length}）`),
              errors.slice(0, 20).map((e, i) => h(ErrorRow, { key: i, item: e })),
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: PANEL_ID,
        kind: PANEL_KIND,
        priority: 'extension',
        title: () => '小程序',
        guide: [{
          order: 7,
          title: () => '小程序开发闭环',
          description: () => 'IDE 状态、预览二维码与编译报错，配合 weapp_* 工具使用',
        }],
      }));
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => {
        const dispose = ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, Panel);
        return () => dispose();
      }));
      void fetch('/dsh-weapp-loop/health', { method: 'GET' }).catch(() => {});
    }

    return { apply, inject: ['slots', 'sidebarRightTabs'] };
  },
});
