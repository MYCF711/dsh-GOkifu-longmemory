// 浏览器半侧：设置 → 长期记忆（棋院），用于选择/查看记忆库地址。
// 约定与 dsh 插件一致：window.__ModuleLoader__.load({id, factory})，导出 apply/inject/name。
window.__ModuleLoader__.load({ id: 'dsh-gokifu-longmemory', factory: (require) => {
  const react = require('react');
  const h = react.createElement;
  const CONFIG_ROUTE = '/kifu-longmemory/config';
  // 与 dshmarket 相同：按 document.baseURI 解析，兼容反向代理前缀与桌面 dsh-app:// 页面。
  function api(path) {
    const relative = String(path || '').replace(/^\/+/, '');
    if (typeof document === 'undefined' || !document.baseURI) return `/${relative}`;
    return new URL(relative, document.baseURI).pathname;
  }
  const NS = 'dsh-gokifu-longmemory';

  async function loadConfig() {
    const res = await fetch(api(CONFIG_ROUTE), { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function saveConfig(patch) {
    const res = await fetch(api(CONFIG_ROUTE), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  function statsLine(stats) {
    if (!stats || stats.exists !== true) return '记忆库还不存在：下一次会话会自动建库（约十几秒，期间沉默）';
    const parts = [];
    if (Number.isFinite(stats.episodes)) parts.push(`${stats.episodes} 局`);
    if (Number.isFinite(stats.claims)) parts.push(`${stats.claims} 条教训`);
    if (Number.isFinite(stats.updatedAt)) {
      const d = new Date(stats.updatedAt);
      if (!Number.isNaN(d.getTime())) parts.push(`更新于 ${d.toLocaleString()}`);
    }
    return parts.length > 0 ? `当前库：${parts.join(' · ')}` : '当前库：已建，暂无统计';
  }

  function LongMemorySection() {
    const [state, setState] = react.useState({ loading: true, error: null, saved: null, stats: null });
    const [value, setValue] = react.useState('');
    const [saving, setSaving] = react.useState(false);

    react.useEffect(() => {
      let alive = true;
      loadConfig()
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, saved: null, stats: data?.stats ?? null });
          setValue(String(data?.config?.storeRoot ?? ''));
        })
        .catch((error) => alive && setState({ loading: false, error: String(error?.message ?? error), saved: null }));
      return () => { alive = false; };
    }, []);

    const onSave = async () => {
      setSaving(true);
      try {
        await saveConfig({ storeRoot: value });
        const data = await loadConfig();
        setState({ loading: false, error: null, saved: data?.effectiveStoreRoot ?? null });
      } catch (error) {
        setState({ loading: false, error: String(error?.message ?? error), saved: null });
      } finally {
        setSaving(false);
      }
    };

    if (state.loading) return h('div', { style: { padding: '12px 0', opacity: 0.7 } }, '读取配置…');

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 0' } },
      h('div', { style: { fontSize: '13px', opacity: 0.8 } },
        '记忆库地址（留空 = <DSH_HOME>/memory-context，推荐留空）'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('input', {
          value,
          onChange: (event) => setValue(event.target.value),
          placeholder: '例如 D:\mem\kifu-longmemory',
          spellCheck: false,
          style: {
            flex: '1 1 auto', minWidth: '240px', padding: '6px 8px',
            borderRadius: '6px', border: '1px solid rgba(127,127,127,.35)',
            background: 'transparent', color: 'inherit', font: 'inherit',
          },
        }),
        h('button', {
          type: 'button',
          disabled: saving,
          onClick: onSave,
          style: {
            padding: '6px 14px', borderRadius: '6px', cursor: saving ? 'default' : 'pointer',
            border: '1px solid rgba(127,127,127,.35)', background: 'rgba(127,127,127,.12)', color: 'inherit',
          },
        }, saving ? '保存中…' : '保存'),
      ),
      h('div', { style: { fontSize: '12px', opacity: 0.7 } }, statsLine(state.stats)),
      state.saved ? h('div', { style: { fontSize: '12px', color: '#2e9e5b' } }, `已保存，当前生效：${state.saved}`) : null,
      state.error ? h('div', { style: { fontSize: '12px', color: '#d04545' } }, `保存失败：${state.error}`) : null,
    );
  }

  const name = NS;

  function apply(ctx) {
    // 不声明 inject：本卡片只用到宿主自带的 slots 服务；若列出未加载的客户端包，
    // 宿主会一直 pending（2026-11-02 实机：dsh-gokifu-longmemory: pending,
    // 等 @deepseek-ai/dsh-client-ui-settings），导致 web 启动卡死。
    if (!ctx?.slots?.inject || !ctx?.slots?.register) return;
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: NS,
      label: () => '长期记忆（棋院）',
      locale: NS,
      order: 40,
    }, LongMemorySection));
  }

  return { name, apply, inject: [] };
} });
