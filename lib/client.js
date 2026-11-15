/**
 * dsh-peak-router browser half — the "Peak Router" Web Extensions page.
 *
 * The page is a thin editor over the host's settings document:
 *   GET  api/dsh-peak-router/state    effective config, defaults, status, catalog
 *   GET  api/dsh-peak-router/models?provider=…
 *   POST api/dsh-peak-router/config   { config } written to <dsh home>/dsh-peak-router.json
 *   POST api/dsh-peak-router/reset    drop the UI overrides, back to profile defaults
 *
 * Route fields are datalists, not fixed selects: the catalog suggests what the
 * profile currently declares, and any provider/model id may still be typed in.
 * That keeps the page provider-agnostic — the host core never learns a name.
 */

window.__ModuleLoader__.load({
  id: 'dsh-peak-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const h = react.createElement

    const NS = 'dsh-peak-router'

    const en = {
      title: 'Peak Router',
      description: 'Run live sessions on a different provider/model while a scheduled peak window is in force, and move them back afterwards.',
      on: 'Enabled',
      off: 'Disabled',
      loading: 'Reading the router…',
      routes: 'Routes',
      peakRoute: 'Peak route',
      offPeakRoute: 'Off-peak route',
      mainRoute: 'Main route (off-peak)',
      peakRoutes: 'Peak routes (in order)',
      peakRoutesHint: 'Tried top to bottom. A route at its usage floor is skipped; when every peak route is spent, the main route is used.',
      addRoute: 'Add route',
      noPeakRoutes: 'No peak routes — the main route is used all day as well.',
      moveUp: 'Move up',
      moveDown: 'Move down',
      remove: 'Remove',
      provider: 'Provider',
      model: 'Model',
      swapBack: 'Move back off-peak',
      respectManual: 'Leave manually chosen models alone',
      advanced: 'Schedule, quota and advanced settings',
      timeZone: 'Time zone (IANA)',
      peakDays: 'Days',
      weekdays: 'Weekdays',
      allDays: 'Every day',
      windows: 'Peak windows',
      windowsHint: 'Comma-separated HH:MM-HH:MM ranges, e.g. 09:00-12:00, 14:00-18:00',
      holidays: 'Extra off-peak dates',
      holidaysHint: 'Comma-separated YYYY-MM-DD',
      quotaAdapter: 'Quota guard',
      none: 'None',
      minRemaining: 'Skip below % left',
      quotaKeyEnv: 'Quota credential',
      quotaBaseURL: 'Quota API origin',
      target: 'Target now: {route}',
      lastSwitch: 'Last switch {from} → {to} at {time}',
      statusPeak: 'Peak window: ends {time}',
      statusOff: 'Off-peak: next window {time}',
      statusAgents: '{n} live route(s)',
      save: 'Save',
      saving: 'Saving…',
      reset: 'Reset to profile defaults',
      saved: 'Saved — live now',
      resetDone: 'Overrides removed',
      loadFailed: 'Could not read the router: {error}',
      saveFailed: 'Save failed: {error}',
      loadingModels: 'Loading models…',
      noModels: 'No models reported',
    }

    const zh = {
      title: '峰谷路由',
      description: '在设定的高峰时段把会话切到另一个提供方/模型，时段结束后切回。',
      on: '已启用',
      off: '已停用',
      loading: '正在读取路由设置…',
      routes: '路由',
      peakRoute: '高峰路由',
      offPeakRoute: '空闲路由',
      mainRoute: '主路由（空闲）',
      peakRoutes: '高峰路由（按顺序）',
      peakRoutesHint: '从上到下依次尝试；配额触底的会被跳过，全部用完后回到主路由。',
      addRoute: '添加路由',
      noPeakRoutes: '没有高峰路由——高峰时段也使用主路由。',
      moveUp: '上移',
      moveDown: '下移',
      remove: '删除',
      provider: '提供方',
      model: '模型',
      swapBack: '空闲时切回',
      respectManual: '尊重手动选择的模型',
      advanced: '时段、配额与高级设置',
      timeZone: '时区（IANA）',
      peakDays: '适用日期',
      weekdays: '工作日',
      allDays: '每天',
      windows: '高峰时段',
      windowsHint: '用逗号分隔 HH:MM-HH:MM，例如 09:00-12:00, 14:00-18:00',
      holidays: '额外空闲日期',
      holidaysHint: '用逗号分隔 YYYY-MM-DD',
      quotaAdapter: '配额保护',
      none: '关闭',
      minRemaining: '剩余低于 % 时跳过',
      quotaKeyEnv: '配额凭据',
      quotaBaseURL: '配额 API 地址',
      target: '当前目标：{route}',
      lastSwitch: '上次切换 {from} → {to}（{time}）',
      statusPeak: '高峰时段：{time} 结束',
      statusOff: '空闲时段：下次 {time}',
      statusAgents: '{n} 个活动路由',
      save: '保存',
      saving: '保存中…',
      reset: '恢复配置默认值',
      saved: '已保存并立即生效',
      resetDone: '已清除界面覆盖',
      loadFailed: '无法读取路由设置：{error}',
      saveFailed: '保存失败：{error}',
      loadingModels: '正在读取模型…',
      noModels: '未读取到模型',
    }

    function dictionary() {
      const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'en'
      return String(lang).toLowerCase().startsWith('zh') ? zh : en
    }

    function t(key, params) {
      let text = dictionary()[key] ?? key
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) {
          text = text.split('{' + name + '}').join(String(value))
        }
      }
      return text
    }

    const FETCH_TIMEOUT_MS = 20_000

    async function api(path, options) {
      const response = await fetch(path, {
        ...(options ?? {}),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status))
      return body
    }

    const apiState = () => api('api/dsh-peak-router/state')
    const apiModels = (provider) => api('api/dsh-peak-router/models?provider=' + encodeURIComponent(provider))
    const apiSave = (config) => api('api/dsh-peak-router/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    const apiReset = () => api('api/dsh-peak-router/reset', { method: 'POST' })

    function clock(ms) {
      try {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      } catch {
        return ''
      }
    }

    const CSS = [
      '.dpr-card{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:16px 18px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dpr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dpr-title{font-size:15px;font-weight:600}',
      '.dpr-desc{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.45;max-width:52ch}',
      '.dpr-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.dpr-pill{display:inline-flex;align-items:center;gap:8px;background:none;border:0;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.dpr-pillTrack{display:inline-block;flex:none;position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-label-dimmed,rgba(127,127,127,.35));transition:background .18s}',
      '.dpr-pill[aria-checked=true] .dpr-pillTrack{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4c6fff))}',
      '.dpr-pillThumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .18s}',
      '.dpr-pill[aria-checked=true] .dpr-pillThumb{left:18px}',
      '.dpr-status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;font-variant-numeric:tabular-nums}',
      '.dpr-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#067647);flex:none}',
      '.dpr-dot.dpr-peak{background:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.dpr-sep{opacity:.45}',
      '.dpr-section{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}',
      '.dpr-section-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-secondary)}',
      '.dpr-route{display:grid;grid-template-columns:96px minmax(0,1fr) minmax(0,1.4fr);align-items:center;gap:8px}','.dpr-route-main{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr)}','.dpr-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}','.dpr-peak-row{display:grid;grid-template-columns:22px minmax(0,1fr) minmax(0,1.4fr) auto;align-items:center;gap:8px}','.dpr-index{font-size:11px;opacity:.55;text-align:right;font-variant-numeric:tabular-nums}','.dpr-row-actions{display:flex;gap:2px}','.dpr-icon{appearance:none;width:22px;height:22px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}','.dpr-icon:hover:not(:disabled){background:color-mix(in srgb,currentColor 10%,transparent)}','.dpr-icon:disabled{opacity:.28;cursor:default}','.dpr-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#b42318)}','.dpr-btn-small{padding:3px 9px;font-size:11px;line-height:1.4}','.dpr-add{appearance:none;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:5px 10px;font:inherit;font-size:11.5px;cursor:pointer;text-align:left}','.dpr-add:hover{background:color-mix(in srgb,currentColor 6%,transparent);color:var(--dsw-alias-label-primary)}',
      '.dpr-route-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dpr-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dpr-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.dpr-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dpr-input{box-sizing:border-box;width:100%;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:13px;min-width:0}',
      '.dpr-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dpr-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}',
      '.dpr-checks{display:flex;flex-wrap:wrap;gap:16px;padding-top:2px}',
      '.dpr-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dpr-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none}',
      '.dpr-statusline{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dpr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dpr-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.dpr-btn:hover:not(:disabled){background:color-mix(in srgb, currentColor 8%, transparent)}',
      '.dpr-btn:disabled{opacity:.5;cursor:default}',
      '.dpr-primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);font-weight:600}',
      '.dpr-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#067647)}',
      '.dpr-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#b42318)}',
      '.dpr-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '@media (max-width: 640px){.dpr-route{grid-template-columns:1fr}.dpr-grid2{grid-template-columns:1fr}}',
    ].join('')

    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-peak-router"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-peak-router'
      tag.dataset.pluginCss = 'dsh-peak-router'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function Field(props) {
      return h('label', { className: 'dpr-field' },
        h('span', { className: 'dpr-label' }, props.label),
        props.kind === 'select'
          ? h('select', {
              className: 'dpr-input',
              value: props.value,
              onChange: (event) => props.onChange(event.target.value),
            }, props.options.map(([value, label]) => h('option', { key: value, value }, label)))
          : h('input', {
              className: 'dpr-input',
              type: props.kind === 'number' ? 'number' : 'text',
              value: props.value,
              min: props.min,
              max: props.max,
              onChange: (event) => props.onChange(event.target.value),
            }),
        props.hint !== undefined ? h('span', { className: 'dpr-hint' }, props.hint) : null,
      )
    }

    /** Provider select fed by the profile's catalog; a persisted id not in it is kept. */
    function ProviderSelect(props) {
      const entries = props.providers.slice()
      if (props.value !== '' && !entries.some((entry) => entry.id === props.value)) {
        entries.unshift({ id: props.value, name: props.value })
      }
      return h('select', {
        className: 'dpr-input',
        value: props.value,
        'aria-label': t('provider'),
        title: t('provider'),
        onChange: (event) => props.onChange(event.target.value),
      }, entries.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))
    }

    /** Model select for one provider; undefined models means "still loading". */
    function ModelSelect(props) {
      const list = Array.isArray(props.models) ? props.models.slice() : []
      if (props.value !== '' && !list.some((entry) => entry.id === props.value)) {
        list.unshift({ id: props.value, name: props.value })
      }
      const loading = !Array.isArray(props.models)
      return h('select', {
        className: 'dpr-input',
        value: props.value,
        'aria-label': t('model'),
        title: t('model'),
        disabled: loading,
        onChange: (event) => props.onChange(event.target.value),
      }, loading
        ? h('option', { value: props.value }, t('loadingModels'))
        : list.length === 0
          ? h('option', { value: props.value }, t('noModels'))
          : list.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))
    }

    /** One row of the ordered peak fallback list. */
    function PeakRouteRow(props) {
      return h('div', { className: 'dpr-peak-row' },
        h('span', { className: 'dpr-index' }, String(props.index + 1)),
        h(ProviderSelect, {
          value: props.provider,
          providers: props.providers,
          onChange: props.onProvider,
        }),
        h(ModelSelect, {
          value: props.model,
          models: props.models,
          onChange: props.onModel,
        }),
        h('span', { className: 'dpr-row-actions' },
          h('button', {
            type: 'button',
            className: 'dpr-icon',
            title: t('moveUp'),
            'aria-label': t('moveUp'),
            disabled: props.index === 0,
            onClick: () => props.onMove(-1),
          }, '↑'),
          h('button', {
            type: 'button',
            className: 'dpr-icon',
            title: t('moveDown'),
            'aria-label': t('moveDown'),
            disabled: props.index === props.count - 1,
            onClick: () => props.onMove(1),
          }, '↓'),
          h('button', {
            type: 'button',
            className: 'dpr-icon dpr-danger',
            title: t('remove'),
            'aria-label': t('remove'),
            onClick: props.onRemove,
          }, '−'),
        ),
      )
    }

    function Toggle(props) {
      return h('label', { className: 'dpr-check' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', null, props.label),
      )
    }

    /** The settings-style pill switch used by the other Web Extensions pages. */
    function PillToggle(props) {
      const checked = props.checked === true
      return h('button', {
        type: 'button',
        className: 'dpr-pill',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        onClick: () => props.onChange(!checked),
      },
        h('span', { className: 'dpr-pillTrack' }, h('span', { className: 'dpr-pillThumb' })),
        h('span', null, props.label),
      )
    }

    /** The draft's peak list: new shape first, the legacy singular pair as fallback. */
    function normalizeRoutes(config) {
      const source = Array.isArray(config.peakRoutes) ? config.peakRoutes : []
      const routes = []
      for (const entry of source) {
        if (entry === null || typeof entry !== 'object') continue
        const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
        const model = typeof entry.model === 'string' ? entry.model.trim() : ''
        if (provider === '' || model === '') continue
        routes.push({ provider, model, reasoningEffort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : '' })
      }
      if (routes.length === 0 && config.peakProvider !== undefined && config.peakModel !== undefined) {
        routes.push({ provider: config.peakProvider, model: config.peakModel, reasoningEffort: config.peakReasoningEffort ?? '' })
      }
      return routes
    }

    function RouterPage() {
      const [state, setState] = react.useState(null)
      const [draft, setDraft] = react.useState(null)
      const [models, setModels] = react.useState({})
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [advanced, setAdvanced] = react.useState(false)

      react.useEffect(() => {
        let live = true
        apiState().then((next) => {
          if (!live) return
          setState(next)
          setDraft({ ...next.config, peakRoutes: normalizeRoutes(next.config) })
        }, (cause) => {
          if (live) setError(t('loadFailed', { error: cause instanceof Error ? cause.message : String(cause) }))
        })
        return () => { live = false }
      }, [])

      react.useEffect(() => {
        const id = window.setInterval(() => {
          apiState().then((next) => {
            setState((previous) => previous === null ? next : { ...previous, status: next.status, catalog: next.catalog, updatedAt: next.updatedAt })
          }, () => {})
        }, 15_000)
        return () => window.clearInterval(id)
      }, [])

      const loadModels = react.useCallback(async (provider) => {
        if (provider === undefined || provider === '') return []
        try {
          const reply = await apiModels(provider)
          const list = Array.isArray(reply.models) ? reply.models : []
          setModels((previous) => ({ ...previous, [provider]: list }))
          return list
        } catch {
          setModels((previous) => ({ ...previous, [provider]: [] }))
          return []
        }
      }, [])

      const providerKey = draft === null
        ? ''
        : [draft.offPeakProvider, ...(draft.peakRoutes ?? []).map((route) => route.provider)].join('|')
      react.useEffect(() => {
        if (draft === null) return
        const seen = new Set()
        for (const provider of [draft.offPeakProvider, ...(draft.peakRoutes ?? []).map((route) => route.provider)]) {
          if (provider === '' || seen.has(provider)) continue
          seen.add(provider)
          void loadModels(provider)
        }
      }, [providerKey, loadModels])

      if (state === null || draft === null) {
        return h('div', { className: 'dpr-card' },
          error !== null
            ? h('div', { className: 'dpr-err' }, error)
            : h('div', { className: 'dpr-muted' }, t('loading')),
        )
      }

      const set = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }))
      const setPeakRoute = (index, patch) => setDraft((previous) => {
        const routes = previous.peakRoutes.slice()
        routes[index] = { ...routes[index], ...patch }
        return { ...previous, peakRoutes: routes }
      })
      /**
       * Add a row on an unused provider that actually reports models; fall back
       * to any provider with a catalog, then to the first provider.
       */
      const addRoute = async () => {
        const used = new Set(draft.peakRoutes.map((route) => route.provider))
        const ordered = [
          ...providers.filter((entry) => !used.has(entry.id)),
          ...providers.filter((entry) => used.has(entry.id)),
        ]
        let chosen
        for (const candidate of ordered) {
          const list = await loadModels(candidate.id)
          if (list.length > 0) {
            chosen = { provider: candidate.id, model: list[0].id }
            break
          }
        }
        if (chosen === undefined) {
          const first = providers[0]
          if (first === undefined) return
          chosen = { provider: first.id, model: '' }
        }
        const route = chosen
        setDraft((previous) => ({
          ...previous,
          peakRoutes: [...previous.peakRoutes, { ...route, reasoningEffort: '' }],
        }))
      }
      const removeRoute = (index) => setDraft((previous) => ({
        ...previous,
        peakRoutes: previous.peakRoutes.filter((_, position) => position !== index),
      }))
      const moveRoute = (index, delta) => setDraft((previous) => {
        const routes = previous.peakRoutes.slice()
        const target = index + delta
        if (target < 0 || target >= routes.length) return previous
        const swapped = routes[index]
        routes[index] = routes[target]
        routes[target] = swapped
        return { ...previous, peakRoutes: routes }
      })
      /** Change the main (off-peak) provider, then keep a model that belongs to it. */
      const changeProvider = async (side, provider) => {
        setDraft((previous) => ({ ...previous, [side + 'Provider']: provider }))
        const list = await loadModels(provider)
        setDraft((previous) => {
          if (previous[side + 'Provider'] !== provider) return previous
          if (list.some((entry) => entry.id === previous[side + 'Model'])) return previous
          return { ...previous, [side + 'Model']: list[0] === undefined ? '' : list[0].id }
        })
      }
      /** Change one peak row's provider and move it to a model of that provider. */
      const changePeakProvider = async (index, provider) => {
        setPeakRoute(index, { provider })
        const list = await loadModels(provider)
        setDraft((previous) => {
          const routes = previous.peakRoutes.slice()
          if (routes[index] === undefined || routes[index].provider !== provider) return previous
          if (list.some((entry) => entry.id === routes[index].model)) return previous
          routes[index] = { ...routes[index], model: list[0] === undefined ? '' : list[0].id }
          return { ...previous, peakRoutes: routes }
        })
      }
      const providers = Array.isArray(state.catalog?.providers) ? state.catalog.providers.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id })) : []
      const status = state.status ?? {}
      const agents = Array.isArray(status.agents) ? status.agents : []

      const save = async () => {
        setBusy(true)
        setNote(null)
        setError(null)
        try {
          const payload = {
            ...draft,
            peakProvider: draft.peakRoutes[0]?.provider ?? '',
            peakModel: draft.peakRoutes[0]?.model ?? '',
            peakReasoningEffort: draft.peakRoutes[0]?.reasoningEffort ?? '',
          }
          const next = await apiSave(payload)
          setState(next)
          setDraft({ ...next.config, peakRoutes: normalizeRoutes(next.config) })
          setNote(t('saved'))
        } catch (cause) {
          setError(t('saveFailed', { error: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setBusy(false)
        }
      }

      const reset = async () => {
        setBusy(true)
        setNote(null)
        setError(null)
        try {
          const next = await apiReset()
          setState(next)
          setDraft({ ...next.config, peakRoutes: normalizeRoutes(next.config) })
          setNote(t('resetDone'))
        } catch (cause) {
          setError(t('saveFailed', { error: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setBusy(false)
        }
      }

      const statusText = status.peak === true
        ? t('statusPeak', { time: clock(status.boundaryMs) })
        : t('statusOff', { time: clock(status.boundaryMs) })

      const targetText = status.target === null || status.target === undefined
        ? t('none')
        : status.target.provider + '/' + status.target.model

      return h('div', { className: 'dpr-card', 'data-dsh-plugin': 'dsh-peak-router' },
        h('div', { className: 'dpr-head' },
          h('div', null,
            h('div', { className: 'dpr-title' }, t('title')),
            h('div', { className: 'dpr-desc' }, t('description')),
          ),
          h(PillToggle, {
            checked: draft.enabled !== false,
            onChange: (value) => set('enabled', value),
            label: draft.enabled !== false ? t('on') : t('off'),
          }),
        ),

        h('div', { className: 'dpr-status' },
          h('span', { className: status.peak === true ? 'dpr-dot dpr-peak' : 'dpr-dot' }),
          h('span', null, statusText),
          h('span', { className: 'dpr-sep' }, '·'),
          h('span', null, t('statusAgents', { n: agents.length })),
        ),

        h('div', { className: 'dpr-section' },
          h('div', { className: 'dpr-section-title' }, t('mainRoute')),
          h('div', { className: 'dpr-route dpr-route-main' },
            h(ProviderSelect, {
              value: draft.offPeakProvider,
              providers,
              onChange: (value) => { void changeProvider('offPeak', value) },
            }),
            h(ModelSelect, {
              value: draft.offPeakModel,
              models: models[draft.offPeakProvider],
              onChange: (value) => set('offPeakModel', value),
            }),
          ),
          h('div', { className: 'dpr-section-head' },
            h('span', { className: 'dpr-section-title' }, t('peakRoutes')),
            h('button', { type: 'button', className: 'dpr-btn dpr-btn-small', onClick: () => { void addRoute() } }, '+ ' + t('addRoute')),
          ),
          h('div', { className: 'dpr-hint' }, t('peakRoutesHint')),
          draft.peakRoutes.map((route, index) => h(PeakRouteRow, {
            key: index,
            index,
            count: draft.peakRoutes.length,
            provider: route.provider,
            model: route.model,
            providers,
            models: models[route.provider],
            onProvider: (value) => { void changePeakProvider(index, value) },
            onModel: (value) => setPeakRoute(index, { model: value }),
            onMove: (delta) => moveRoute(index, delta),
            onRemove: () => removeRoute(index),
          })),
          draft.peakRoutes.length === 0
            ? h('div', { className: 'dpr-hint' }, t('noPeakRoutes'))
            : null,
          h('button', { type: 'button', className: 'dpr-add', onClick: () => { void addRoute() } }, '+ ' + t('addRoute')),
          h('div', { className: 'dpr-checks' },
            h(Toggle, { checked: draft.swapBack, onChange: (value) => set('swapBack', value), label: t('swapBack') }),
            h(Toggle, { checked: draft.respectManualSelection, onChange: (value) => set('respectManualSelection', value), label: t('respectManual') }),
          ),
        ),

        h('details', { className: 'dpr-details', open: advanced, onToggle: (event) => setAdvanced(event.currentTarget.open) },
          h('summary', null, t('advanced')),
          h('div', { className: 'dpr-section' },
            h('div', { className: 'dpr-grid2' },
              h(Field, { label: t('timeZone'), value: draft.timeZone, onChange: (value) => set('timeZone', value) }),
              h(Field, {
                label: t('peakDays'),
                kind: 'select',
                value: draft.peakDays,
                options: [['weekdays', t('weekdays')], ['all', t('allDays')]],
                onChange: (value) => set('peakDays', value),
              }),
            ),
            h(Field, {
              label: t('windows'),
              value: (draft.peakWindows ?? []).join(', '),
              hint: t('windowsHint'),
              onChange: (value) => set('peakWindows', value.split(',').map((part) => part.trim()).filter(Boolean)),
            }),
            h(Field, {
              label: t('holidays'),
              value: (draft.holidays ?? []).join(', '),
              hint: t('holidaysHint'),
              onChange: (value) => set('holidays', value.split(',').map((part) => part.trim()).filter(Boolean)),
            }),
            h('div', { className: 'dpr-grid2' },
              h(Field, {
                label: t('quotaAdapter'),
                kind: 'select',
                value: draft.quotaAdapter,
                options: [['deeprelay', 'deeprelay'], ['none', t('none')]],
                onChange: (value) => set('quotaAdapter', value),
              }),
              h(Field, {
                label: t('minRemaining'),
                kind: 'number',
                min: 0,
                max: 100,
                value: String(draft.minRemainingPercent),
                onChange: (value) => set('minRemainingPercent', Number(value)),
              }),
            ),
            h('div', { className: 'dpr-grid2' },
              h(Field, {
                label: t('quotaKeyEnv'),
                value: draft.quotaApiKeyEnv,
                onChange: (value) => set('quotaApiKeyEnv', value),
              }),
              h(Field, {
                label: t('quotaBaseURL'),
                value: draft.quotaBaseURL,
                onChange: (value) => set('quotaBaseURL', value),
              }),
            ),
          ),
        ),

        h('div', { className: 'dpr-statusline' },
          h('span', null, t('target', { route: targetText })),
          status.lastSwitch !== undefined && h('span', null, t('lastSwitch', {
            from: status.lastSwitch.from.provider + '/' + status.lastSwitch.from.model,
            to: status.lastSwitch.to.provider + '/' + status.lastSwitch.to.model,
            time: clock(status.lastSwitch.at),
          })),
        ),

        h('div', { className: 'dpr-actions' },
          h('button', { type: 'button', className: 'dpr-btn dpr-primary', disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'dpr-btn', disabled: busy, onClick: reset }, t('reset')),
          note !== null ? h('span', { className: 'dpr-ok' }, note) : null,
          error !== null ? h('span', { className: 'dpr-err' }, error) : null,
        ),
      )
    }

    /** Read the optional Web Extensions parent service without assuming a test double. */
    function extensionsService(ctx) {
      if (typeof ctx.get !== 'function') return undefined
      try {
        const candidate = ctx.get('webUiExtensions')
        return candidate !== null
          && typeof candidate === 'object'
          && typeof candidate.sectionId === 'string'
          && typeof candidate.registerPage === 'function'
          ? candidate
          : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Seat the page in the Web Extensions parent, falling back to a first-level
     * settings section when that group plugin is not installed.
     */
    function installPage(ctx, page) {
      let dispose
      let current
      const reconcile = () => {
        const service = extensionsService(ctx)
        const target = service === undefined ? 'legacy' : 'integrated'
        if (current === target && dispose !== undefined) return
        // The first pass can run before the Web Extensions parent (or the
        // legacy settings slot) is declared; wait for slots/changed instead of
        // attempting a registration the renderer will reject.
        if (target === 'legacy'
          && typeof ctx.slots.spec === 'function'
          && ctx.slots.spec('settings.section') === undefined) return
        try {
          dispose?.()
        } catch {
          // Previous seat already gone.
        }
        try {
          dispose = target === 'integrated'
            ? service.registerPage(page)
            : ctx.slots.register({
                name: 'settings.section',
                id: page.key,
                order: page.order,
                label: page.label,
                locale: page.locale,
                inject: page.inject,
              }, page.component)
          current = target
        } catch (error) {
          dispose = undefined
          current = undefined
          try { console.warn('[dsh-peak-router] page mount failed', error) } catch {}
        }
      }
      let off
      if (typeof ctx.on === 'function') {
        try { off = ctx.on('slots/changed', reconcile) } catch { off = undefined }
      }
      reconcile()
      return () => {
        try { off?.() } catch {}
        try { dispose?.() } catch {}
        dispose = undefined
        current = undefined
      }
    }

    function apply(ctx) {
      installStyles()
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { en, zh })
        } catch {
          return () => {}
        }
      }, 'dsh-peak-router: locale')

      ctx.effect(() => installPage(ctx, {
        key: 'peak-router',
        order: 152,
        locale: NS,
        label: () => t('title'),
        inject: () => ({}),
        component: RouterPage,
      }), 'dsh-peak-router: settings page')
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
