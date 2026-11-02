// 浏览器半侧：设置 → 长期记忆（棋院），用于选择/查看记忆库地址。
// 约定与 dsh 插件一致：window.__ModuleLoader__.load({id, factory})，导出 apply/inject/name。
window.__ModuleLoader__.load({ id: 'dsh-gokifu-longmemory', factory: (require) => {
  const react = require('react');
  const h = react.createElement;
  const CONFIG_ROUTE = '/kifu-longmemory/config';
  const NS = 'dsh-gokifu-longmemory';

  async function loadConfig() {
    const res = await fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function saveConfig(patch) {
    const res = await fetch(CONFIG_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  function LongMemorySection() {
    const [state, setState] = react.useState({ loading: true, error: null, saved: null });
    const [value, setValue] = react.useState('');
    const [saving, setSaving] = react.useState(false);

    react.useEffect(() => {
      let alive = true;
      loadConfig()
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, saved: null });
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
      state.saved ? h('div', { style: { fontSize: '12px', color: '#2e9e5b' } }, `已保存，当前生效：${state.saved}`) : null,
      state.error ? h('div', { style: { fontSize: '12px', color: '#d04545' } }, `保存失败：${state.error}`) : null,
    );
  }

  const name = NS;

  function apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: NS,
      label: () => '长期记忆（棋院）',
      locale: NS,
      order: 40,
    }, LongMemorySection));
  }

  return { name, apply, inject: ['@deepseek-ai/dsh-client-ui-settings'] };
} });
