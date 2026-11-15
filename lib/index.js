/**
 * dsh-peak-router — run live sessions on a different route during another
 * provider's peak-pricing window, and (optionally) move them back afterwards.
 *
 * Nothing here is tied to DeepSeek or deeprelay:
 *
 * - the peak clock is a generic IANA-time-zone schedule (`timeZone`,
 *   `peakWindows`, `peakDays`, `holidays`);
 * - both sides of the swap are arbitrary `provider` / `model` pairs taken from
 *   whatever adapters the profile declares;
 * - the quota guard is a pluggable adapter (`quotaAdapter`), and `none` turns
 *   it off for providers that expose no subscription meter;
 * - `enabled: false` removes the plugin's behaviour entirely.
 *
 * The routing seam is `agent.model.select()`. It records a durable
 * `model/selection` that applies to the next step whose preparation has not
 * begun, so a switch is auditable in the session log and never mutates a
 * request in flight. The deprecated `agent/request` hook is deliberately not
 * used: this Harness fixes provider/model at step preparation and rejects a
 * listener that changes them.
 *
 * A browser half (lib/client.js) contributes the "Peak Router" Web Extensions
 * page. This half serves its state and accepts its saves, keeping the UI
 * overrides in `<dsh home>/dsh-peak-router.json` so the profile patch stays a
 * set of defaults rather than the only way to configure the plugin.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-peak-router'
/** The agent registry and the web server routes (when this is a web profile). */
export const inject = ['agents']

export const Config = z.object({
  /** Master switch. Off = no switches; the page still serves. */
  enabled: z.boolean().default(true),

  // --- the two sides of the swap (any provider, any model) ----------------
  /** Route to use while the schedule says "peak". */
  peakProvider: z.string().default('deeprelay'),
  peakModel: z.string().default('deeprelay/deepseek-v4.1-flash'),
  /** Optional adapter reasoning effort for the legacy peak route; empty = adapter default. */
  peakReasoningEffort: z.string().default(''),
  /**
   * Ordered peak preference list. At peak the router picks the first route
   * whose subscription meter still has room; an exhausted route falls through
   * to the next, and the off-peak route is the last resort.
   */
  peakRoutes: z.array(z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),
  })).default([]),
  /** Route to use while the schedule says "off-peak". */
  offPeakProvider: z.string().default('deepseek-account'),
  offPeakModel: z.string().default('deepseek-flash'),
  /** Optional adapter reasoning effort for the off-peak route; empty = adapter default. */
  offPeakReasoningEffort: z.string().default(''),
  /** Move sessions back to the off-peak route when peak ends. Off = one-way. */
  swapBack: z.boolean().default(true),
  /**
   * Leave a session alone once the user has chosen a model different from the
   * one this plugin last set for it. The choice sticks until restart.
   */
  respectManualSelection: z.boolean().default(true),

  // --- when "peak" is ------------------------------------------------------
  /** IANA time zone the window and holiday dates are read in. */
  timeZone: z.string().default('Asia/Shanghai'),
  /** Windows as `HH:MM-HH:MM`, in `timeZone`. May cross midnight (22:00-02:00). */
  peakWindows: z.array(z.string()).default(['09:00-12:00', '14:00-18:00']),
  /** `weekdays` (Mon-Fri) or `all`. */
  peakDays: z.union(['weekdays', 'all']).default('weekdays'),
  /** Extra off-peak dates in `timeZone` (public holidays), `YYYY-MM-DD`. */
  holidays: z.array(z.string()).default([]),

  // --- optional quota guard ------------------------------------------------
  /** Subscription-meter reader: `deeprelay` reads /v1/billing/subscription, `none` disables. */
  quotaAdapter: z.union(['deeprelay', 'none']).default('deeprelay'),
  /** The route provider whose meter the guard reads; other targets skip it. */
  quotaProvider: z.string().default('deeprelay'),
  /** Credential reference holding that provider's API key. */
  quotaApiKeyEnv: z.string().default('DEEPRELAY_API_KEY'),
  /** API origin; the deeprelay adapter appends `/v1/billing/subscription`. */
  quotaBaseURL: z.string().default('https://api.deeprelay.ai'),
  /** Skip the swap when any meter has less than this percent left. */
  minRemainingPercent: z.number().min(0).max(100).default(1),
})

/** How often managed sessions are re-checked without a schedule boundary. */
const SAFETY_INTERVAL_MS = 60_000

/** Cache a quota read so a burst of agents does not hammer the endpoint. */
const QUOTA_CACHE_MS = 60_000

/** Model catalogs change rarely; one read per provider per five minutes is plenty. */
const CATALOG_CACHE_MS = 5 * 60_000

/** Largest settings body the save route accepts. */
const MAX_BODY_BYTES = 64 * 1024

/** Follow the live reference a volatile config field produces. */
function read(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/** Parsed `HH:MM-HH:MM` windows as `[fromMinute, toMinute]`; wrapping windows keep `to < from`. */
export function parseWindows(list) {
  const windows = []
  for (const entry of Array.isArray(list) ? list : []) {
    const match = typeof entry === 'string' ? /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(entry) : null
    if (match === null) continue
    const from = Number(match[1]) * 60 + Number(match[2])
    const to = Number(match[3]) * 60 + Number(match[4])
    if (from > 24 * 60 || to > 24 * 60) continue
    windows.push([from, to])
  }
  return windows
}

/** A memoized `Intl.DateTimeFormat` per zone; an invalid zone falls back to Shanghai. */
const formatters = new Map()
export function formatterFor(timeZone) {
  const key = typeof timeZone === 'string' && timeZone !== '' ? timeZone : 'Asia/Shanghai'
  const cached = formatters.get(key)
  if (cached !== undefined) return { formatter: cached, timeZone: key }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatters.set(key, formatter)
    return { formatter, timeZone: key }
  } catch {
    return formatterFor('Asia/Shanghai')
  }
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * Local calendar facts at `ms` in a zone.
 * @param {number} ms - instant.
 * @param {string} timeZone - IANA zone.
 * @returns {{minutes: number, weekday: number, date: string}}
 */
export function zoneParts(ms, timeZone) {
  const { formatter } = formatterFor(timeZone)
  const parts = {}
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const hour = Number(parts.hour) % 24
  return {
    minutes: hour * 60 + Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 1,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  }
}

/**
 * Whether `ms` falls inside a peak window.
 * @param {number} ms - instant.
 * @param {{timeZone: string, windows: number[][], peakDays: string, holidays: readonly string[]}} options
 * @returns {boolean}
 */
export function isPeakAt(ms, options) {
  const part = zoneParts(ms, options.timeZone)
  if (options.peakDays !== 'all' && (part.weekday === 0 || part.weekday === 6)) return false
  if (options.holidays.includes(part.date)) return false
  for (const [from, to] of options.windows) {
    if (from === to) continue
    if (from < to) {
      if (part.minutes >= from && part.minutes < to) return true
    } else if (part.minutes >= from || part.minutes < to) {
      // A window crossing midnight belongs to one continuous peak block.
      return true
    }
  }
  return false
}

/**
 * The billing period at `ms` and the instant it next flips. The scan walks
 * minute boundaries so it needs no zone-offset arithmetic and stays correct
 * across DST changes and midnight-crossing windows.
 * @param {number} ms - instant to classify.
 * @param {{timeZone?: string, peakWindows?: readonly string[], peakDays?: string, holidays?: readonly string[]}} [options]
 * @returns {{peak: boolean, boundaryMs: number}}
 */
export function peakPeriodAt(ms, options = {}) {
  const resolved = {
    timeZone: options.timeZone ?? 'Asia/Shanghai',
    windows: parseWindows(options.peakWindows ?? ['09:00-12:00', '14:00-18:00']),
    peakDays: options.peakDays === 'all' ? 'all' : 'weekdays',
    holidays: options.holidays ?? [],
  }
  const peak = isPeakAt(ms, resolved)
  const firstMinute = Math.floor(ms / 60_000) * 60_000 + 60_000
  const limit = firstMinute + 8 * 24 * 60 * 60_000
  for (let at = firstMinute; at < limit; at += 60_000) {
    if (isPeakAt(at, resolved) !== peak) return { peak, boundaryMs: at }
  }
  return { peak, boundaryMs: ms + 86_400_000 }
}

/** Same route, ignoring reasoning effort. */
function sameRoute(left, right) {
  return left !== undefined && right !== undefined
    && left.provider === right.provider && left.model === right.model
}

/** Normalize a persisted route list, dropping entries with an empty side. */
export function normalizePeakRoutes(list) {
  const routes = []
  for (const entry of Array.isArray(list) ? list : []) {
    const route = entry !== null && typeof entry === 'object'
      ? routeOf(String(entry.provider ?? ''), String(entry.model ?? ''), entry.reasoningEffort ?? '')
      : undefined
    if (route !== undefined) routes.push(route)
  }
  return routes
}

/** Build a selection from a provider/model pair; empty strings make it undefined. */
function routeOf(provider, model, effort) {
  const p = typeof provider === 'string' ? provider.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (p === '' || m === '') return undefined
  const e = typeof effort === 'string' ? effort.trim() : ''
  return e === '' ? { provider: p, model: m } : { provider: p, model: m, reasoningEffort: e }
}

/** DSH home follows the same `DSH_HOME` override the rest of the host uses. */
function dshHome() {
  const override = process.env.DSH_HOME
  return override !== undefined && override !== '' ? override : join(homedir(), '.dsh')
}

/** One JSON response with no-store semantics. */
function writeJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(data)
}

// ---------------------------------------------------------------------------
// Trust fence for the two settings routes: loopback, a paired device, or a
// request addressed to this machine's own LAN address (dsh-web-lan-access).
// The usage plugin ships the same fence; the two plugins are independently
// installable, so the copy stays local.
// ---------------------------------------------------------------------------

function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

function isProxiedRequest(request) {
  return request.headers['cf-connecting-ip'] !== undefined
    || request.headers['x-forwarded-for'] !== undefined
}

function sameOriginMarkers(request, hostUrl) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  return sameOriginMarkers(request, hostUrl)
}

function isTrustedLanRequest(request) {
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const os = globalThis.process?.getBuiltinModule?.('os')
  if (!os) return false
  const addresses = Object.values(os.networkInterfaces()).flat()
    .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address)
  if (!addresses.includes(hostUrl.hostname)) return false
  return sameOriginMarkers(request, hostUrl)
}

function isRouterAllowed(ctx, request) {
  if (isLoopbackRequest(request)) return true
  if (isTrustedLanRequest(request)) return true
  try {
    const pairing = ctx.get('remoteWebUiPairing', false)
    return pairing !== undefined && pairing !== null && typeof pairing.isPairedDevice === 'function'
      && pairing.isPairedDevice(request) === true
  } catch {
    return false
  }
}

/**
 * Subscription-meter adapters. Each returns the tightest remaining percentage
 * of its meters, or undefined when the fact is unavailable. Adding a provider
 * means adding one entry here; the routing core never learns its name.
 */
const QUOTA_ADAPTERS = {
  /**
   * deeprelay flat plans: four weighted meters (monthly/7-day x input/output).
   * `/v1/billing/subscription` is the server's own gate; `subscribed` is the
   * entitlement flag and a null `usage` means "unknown", never "nothing used".
   */
  async deeprelay({ ctx, apiKeyEnv, baseURL }) {
    let key
    try {
      const credentials = ctx.get('credentials', false)
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(credentialRef(apiKeyEnv))
        if (typeof hit?.value === 'string' && hit.value !== '') key = hit.value
      }
    } catch {
      // Fall through to the process environment.
    }
    if (key === undefined) key = process.env[apiKeyEnv]
    if (typeof key !== 'string' || key === '') return undefined
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/v1/billing/subscription`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (body?.subscribed !== true) throw new Error('no active subscription')
    const quota = body.quota ?? {}
    const usage = body.usage ?? {}
    const pairs = [
      [quota.input_tokens_monthly, usage.weighted_input_tokens],
      [quota.output_tokens_monthly, usage.weighted_output_tokens],
      [quota.weekly_input_tokens, usage.weekly_weighted_input_tokens],
      [quota.weekly_output_tokens, usage.weekly_weighted_output_tokens],
    ].filter(([limit]) => typeof limit === 'number' && limit > 0)
    if (pairs.length === 0) throw new Error('no meters')
    return Math.min(...pairs.map(([limit, used]) => ((limit - (Number(used) || 0)) / limit) * 100))
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const statePath = join(dshHome(), 'dsh-peak-router.json')

  /** UI overrides from the state file; the profile patch stays the base. */
  let overrides = {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.config !== null && typeof parsed.config === 'object') {
      overrides = parsed.config
    }
  } catch {
    // No saved overrides yet (or an unreadable file) keeps the profile defaults.
  }

  const loaderSettings = () => {
    const peakRoutes = normalizePeakRoutes(read(config.peakRoutes, []))
    const legacyPeak = routeOf(
      String(read(config.peakProvider, 'deeprelay')),
      String(read(config.peakModel, 'deeprelay/deepseek-v4.1-flash')),
      read(config.peakReasoningEffort, ''),
    )
    if (peakRoutes.length === 0 && legacyPeak !== undefined) peakRoutes.push(legacyPeak)
    return {
      enabled: read(config.enabled, true),
      peakRoutes,
      peakProvider: String(read(config.peakProvider, 'deeprelay')),
      peakModel: String(read(config.peakModel, 'deeprelay/deepseek-v4.1-flash')),
      peakReasoningEffort: String(read(config.peakReasoningEffort, '')),
      offPeakProvider: String(read(config.offPeakProvider, 'deepseek-account')),
      offPeakModel: String(read(config.offPeakModel, 'deepseek-flash')),
      offPeakReasoningEffort: String(read(config.offPeakReasoningEffort, '')),
      swapBack: read(config.swapBack, true),
      respectManualSelection: read(config.respectManualSelection, true),
      timeZone: String(read(config.timeZone, 'Asia/Shanghai')),
      peakWindows: read(config.peakWindows, ['09:00-12:00', '14:00-18:00']),
      peakDays: read(config.peakDays, 'weekdays'),
      holidays: read(config.holidays, []),
      quotaAdapter: String(read(config.quotaAdapter, 'deeprelay')),
      quotaProvider: String(read(config.quotaProvider, 'deeprelay')),
      quotaApiKeyEnv: String(read(config.quotaApiKeyEnv, 'DEEPRELAY_API_KEY')),
      quotaBaseURL: String(read(config.quotaBaseURL, 'https://api.deeprelay.ai')),
      minRemainingPercent: Number(read(config.minRemainingPercent, 1)),
    }
  }

  /** Effective settings: profile defaults with UI overrides on top. */
  const settings = () => {
    const base = loaderSettings()
    const value = { ...base }
    for (const key of Object.keys(overrides)) {
      if (key in base) value[key] = overrides[key]
    }
    value.enabled = value.enabled === true
    const peakRoutes = normalizePeakRoutes(value.peakRoutes)
    if (peakRoutes.length === 0) {
      const legacyPeak = routeOf(value.peakProvider, value.peakModel, value.peakReasoningEffort)
      if (legacyPeak !== undefined) peakRoutes.push(legacyPeak)
    }
    return {
      ...value,
      peakRoutes,
      offPeakRoute: routeOf(value.offPeakProvider, value.offPeakModel, value.offPeakReasoningEffort),
      peakWindows: Array.isArray(value.peakWindows) ? value.peakWindows : base.peakWindows,
      holidays: Array.isArray(value.holidays) ? value.holidays : base.holidays,
    }
  }

  // ---- quota + catalog caches -------------------------------------------
  /** Per-provider meter cache: one API read per provider per minute. */
  const quotaCache = new Map()
  const catalogCache = new Map()

  async function quotaRemainingPercent(s, route, allowNetwork = true) {
    if (s.quotaAdapter === 'none') return undefined
    const adapter = QUOTA_ADAPTERS[route.provider]
    if (adapter === undefined) return undefined
    const cacheKey = `${route.provider}|${s.quotaBaseURL}|${s.quotaApiKeyEnv}`
    const cached = quotaCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < QUOTA_CACHE_MS) return cached.percent
    if (!allowNetwork) return undefined
    try {
      const percent = await adapter({ ctx, apiKeyEnv: s.quotaApiKeyEnv, baseURL: s.quotaBaseURL })
      quotaCache.set(cacheKey, { at: Date.now(), percent })
      return percent
    } catch (error) {
      quotaCache.set(cacheKey, { at: Date.now(), percent: undefined })
      log('warn', `quota read failed for ${route.provider} (${error instanceof Error ? error.message : String(error)}); treating it as available`)
      return undefined
    }
  }

  /** Model ids a provider advertises, cached; an unregistered provider yields []. */
  async function listModels(provider) {
    const cached = catalogCache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.models
    let models = []
    try {
      const llm = ctx.get('llm', false)
      if (llm !== undefined && typeof llm.listModels === 'function') {
        const rows = await llm.listModels(provider)
        models = (Array.isArray(rows) ? rows : []).map(row => ({
          id: String(row.id),
          name: String(row.name ?? row.id),
        }))
      }
    } catch {
      models = []
    }
    catalogCache.set(provider, { at: Date.now(), models })
    return models
  }

  function providerCatalog() {
    try {
      const llm = ctx.get('llm', false)
      if (llm !== undefined && typeof llm.listProviders === 'function') {
        return llm.listProviders().map(entry => ({ id: String(entry.id), name: String(entry.name ?? entry.id) }))
      }
    } catch {
      // No LLM runtime: the page can still name routes by hand.
    }
    return []
  }

  // ---- lifecycle state ---------------------------------------------------
  const applied = new Map()
  let timer
  let safetyTimer
  let refreshInFlight = false
  let disposed = false
  /** Last actual switch, for the settings page's status line. */
  let lastSwitch

  function log(level, message) {
    try {
      const logger = ctx.logger
      const write = logger?.[level]
      if (typeof write === 'function') write.call(logger, `[peak-router] ${message}`)
      else if (level === 'warn' || level === 'error') console.warn(`[peak-router] ${message}`)
    } catch {
      // Logging must never break routing.
    }
  }

  /**
   * Pick the peak route in preference order: the first one whose meter is above
   * the floor wins. A route whose provider exposes no meter is assumed to have
   * room. If every peak route is spent, the off-peak (main) route is the last
   * resort even when swapBack is off — an exhausted route must not keep traffic.
   */
  async function peakTarget(s, allowNetwork = true) {
    if (s.peakRoutes.length === 0) {
      return s.offPeakRoute === undefined ? undefined : { route: s.offPeakRoute, peak: false }
    }
    for (const route of s.peakRoutes) {
      const remaining = await quotaRemainingPercent(s, route, allowNetwork)
      if (remaining === undefined || remaining >= s.minRemainingPercent) {
        return { route, peak: true }
      }
      log('info', `${route.provider}/${route.model} at ${remaining.toFixed(2)}% left; trying the next peak route`)
    }
    if (s.offPeakRoute === undefined) return undefined
    log('warn', 'every peak route is at its meter floor; using the off-peak route')
    return { route: s.offPeakRoute, peak: false }
  }

  const targetNow = async (s, allowNetwork = true) => {
    const period = peakPeriodAt(Date.now(), {
      timeZone: s.timeZone,
      peakWindows: s.peakWindows,
      peakDays: s.peakDays,
      holidays: s.holidays,
    })
    if (period.peak) return peakTarget(s, allowNetwork)
    if (!s.swapBack) return undefined
    return { route: s.offPeakRoute, peak: false }
  }

  function applyTo(agent, s, target) {
    if (disposed || target === undefined) return
    const route = target.route
    if (route === undefined) return
    let current
    try {
      current = agent.model?.current()
    } catch {
      return
    }
    if (current === undefined) return
    if (sameRoute(current, route)) {
      applied.set(agent, route)
      return
    }
    if (s.respectManualSelection) {
      const last = applied.get(agent)
      if (last !== undefined && !sameRoute(current, last)) return
      const managed = [...s.peakRoutes, s.offPeakRoute].filter(entry => entry !== undefined)
      if (last === undefined && !managed.some(entry => sameRoute(entry, current))) return
    }
    try {
      agent.model.select({ ...route })
      applied.set(agent, route)
      lastSwitch = { at: Date.now(), from: { ...current }, to: { ...route }, peak: target.peak }
      log('info', `${current.provider}/${current.model} -> ${route.provider}/${route.model} (${target.peak ? 'peak' : 'off-peak'})`)
    } catch (error) {
      log('warn', `select failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function refresh() {
    if (disposed || refreshInFlight) return
    refreshInFlight = true
    try {
      const s = settings()
      if (!s.enabled) return
      const target = await targetNow(s)
      if (target === undefined) return
      let agents
      try {
        agents = ctx.agents.list()
      } catch {
        return
      }
      for (const agent of agents) applyTo(agent, s, target)
    } finally {
      refreshInFlight = false
    }
  }

  function scheduleBoundary() {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    const s = settings()
    const period = peakPeriodAt(Date.now(), {
      timeZone: s.timeZone,
      peakWindows: s.peakWindows,
      peakDays: s.peakDays,
      holidays: s.holidays,
    })
    const delay = Math.max(500, Math.min(period.boundaryMs - Date.now() + 250, 6 * 3_600_000))
    timer = setTimeout(() => {
      void refresh().finally(scheduleBoundary)
    }, delay)
  }

  // ---- settings-page state ----------------------------------------------

  async function statusNow(s) {
    const period = peakPeriodAt(Date.now(), {
      timeZone: s.timeZone,
      peakWindows: s.peakWindows,
      peakDays: s.peakDays,
      holidays: s.holidays,
    })
    const routes = new Map()
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch {
      agents = []
    }
    for (const agent of agents) {
      let current
      try {
        current = agent.model?.current()
      } catch {
        current = undefined
      }
      if (current === undefined) continue
      const key = `${current.provider}/${current.model}`
      routes.set(key, (routes.get(key) ?? 0) + 1)
    }
    return {
      now: Date.now(),
      peak: period.peak,
      boundaryMs: period.boundaryMs,
      target: (await targetNow(s))?.route ?? null,
      agents: [...routes.entries()].map(([route, count]) => ({ route, count })),
      ...(lastSwitch !== undefined ? { lastSwitch } : {}),
    }
  }

  async function stateDocument() {
    const s = settings()
    return {
      ok: true,
      config: {
        enabled: s.enabled,
        peakRoutes: s.peakRoutes.map((route) => ({
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort ?? '',
        })),
        peakProvider: s.peakProvider,
        peakModel: s.peakModel,
        peakReasoningEffort: s.peakReasoningEffort,
        offPeakProvider: s.offPeakProvider,
        offPeakModel: s.offPeakModel,
        offPeakReasoningEffort: s.offPeakReasoningEffort,
        swapBack: s.swapBack,
        respectManualSelection: s.respectManualSelection,
        timeZone: s.timeZone,
        peakWindows: s.peakWindows,
        peakDays: s.peakDays,
        holidays: s.holidays,
        quotaAdapter: s.quotaAdapter,
        quotaProvider: s.quotaProvider,
        quotaApiKeyEnv: s.quotaApiKeyEnv,
        quotaBaseURL: s.quotaBaseURL,
        minRemainingPercent: s.minRemainingPercent,
      },
      defaults: loaderSettings(),
      overridden: Object.keys(overrides),
      status: await statusNow(s),
      catalog: { providers: providerCatalog() },
      updatedAt: Date.now(),
    }
  }

  /** Validate one settings save; returns a normalized config or an error string. */
  function validateConfig(input) {
    if (input === null || typeof input !== 'object') return { error: 'config must be an object' }
    const value = input
    const text = (key) => typeof value[key] === 'string' ? value[key].trim() : ''
    const provider = (key) => {
      const v = text(key)
      if (v === '') throw new Error(`${key} must not be empty`)
      return v
    }
    const bool = (key, fallback) => typeof value[key] === 'boolean' ? value[key] : fallback
    try {
      const peakRoutes = []
      for (const entry of Array.isArray(value.peakRoutes) ? value.peakRoutes : []) {
        if (entry === null || typeof entry !== 'object') continue
        const entryProvider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
        const entryModel = typeof entry.model === 'string' ? entry.model.trim() : ''
        if (entryProvider === '' || entryModel === '') continue
        peakRoutes.push({
          provider: entryProvider,
          model: entryModel,
          reasoningEffort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort.trim() : '',
        })
      }
      const offPeakProvider = provider('offPeakProvider')
      const offPeakModel = provider('offPeakModel')
      const timeZone = text('timeZone') === '' ? 'Asia/Shanghai' : text('timeZone')
      try {
        new Intl.DateTimeFormat('en-US', { timeZone })
      } catch {
        throw new Error(`unknown time zone "${timeZone}"`)
      }
      const windows = Array.isArray(value.peakWindows) ? value.peakWindows.map(String) : []
      if (parseWindows(windows).length === 0) throw new Error('peakWindows needs at least one HH:MM-HH:MM entry')
      const days = value.peakDays === 'all' ? 'all' : 'weekdays'
      const holidays = Array.isArray(value.holidays)
        ? value.holidays.map(String).map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
        : []
      const quotaAdapter = value.quotaAdapter === 'none' ? 'none' : 'deeprelay'
      const minRemainingPercent = Number(value.minRemainingPercent)
      if (!Number.isFinite(minRemainingPercent) || minRemainingPercent < 0 || minRemainingPercent > 100) {
        throw new Error('minRemainingPercent must be between 0 and 100')
      }
      return {
        config: {
          enabled: bool('enabled', true),
          peakRoutes,
          peakProvider: peakRoutes.length === 0 ? '' : peakRoutes[0].provider,
          peakModel: peakRoutes.length === 0 ? '' : peakRoutes[0].model,
          peakReasoningEffort: peakRoutes.length === 0 ? '' : peakRoutes[0].reasoningEffort,
          offPeakProvider,
          offPeakModel,
          offPeakReasoningEffort: text('offPeakReasoningEffort'),
          swapBack: bool('swapBack', true),
          respectManualSelection: bool('respectManualSelection', true),
          timeZone,
          peakWindows: windows,
          peakDays: days,
          holidays,
          quotaAdapter,
          quotaProvider: peakRoutes.length === 0 ? '' : peakRoutes[0].provider,
          quotaApiKeyEnv: text('quotaApiKeyEnv') === '' ? 'DEEPRELAY_API_KEY' : text('quotaApiKeyEnv'),
          quotaBaseURL: text('quotaBaseURL') === '' ? 'https://api.deeprelay.ai' : text('quotaBaseURL'),
          minRemainingPercent,
        },
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  function writeState() {
    const document = { version: 1, config: overrides }
    const temp = `${statePath}.${process.pid}.tmp`
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(temp, JSON.stringify(document, null, 1), 'utf8')
    renameSync(temp, statePath)
  }

  /** Read one JSON body with a size cap. */
  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (size === 0) return undefined
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  function registerRoutes() {
    const server = ctx.get('webServer', false)
    if (server === undefined || typeof server.register !== 'function') return () => {}
    const disposers = [
      server.register({
        kind: 'exact',
        path: '/api/dsh-peak-router/state',
        handler: async (req, res) => {
          if (!isRouterAllowed(ctx, req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          writeJson(res, 200, await stateDocument())
        },
      }),
      server.register({
        kind: 'exact',
        path: '/api/dsh-peak-router/models',
        handler: async (req, res) => {
          if (!isRouterAllowed(ctx, req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          const provider = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('provider') ?? ''
          if (provider === '') {
            writeJson(res, 400, { ok: false, error: 'provider is required' })
            return
          }
          writeJson(res, 200, { ok: true, provider, models: await listModels(provider) })
        },
      }),
      server.register({
        kind: 'exact',
        path: '/api/dsh-peak-router/config',
        handler: async (req, res) => {
          if (!isRouterAllowed(ctx, req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const body = await readBody(req)
            const checked = validateConfig(body?.config ?? body)
            if (checked.error !== undefined) {
              writeJson(res, 400, { ok: false, error: checked.error })
              return
            }
            overrides = checked.config
            writeState()
            catalogCache.clear()
            await refresh()
            scheduleBoundary()
            writeJson(res, 200, await stateDocument())
          } catch (error) {
            writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'save failed' })
          }
        },
      }),
      server.register({
        kind: 'exact',
        path: '/api/dsh-peak-router/reset',
        handler: async (req, res) => {
          if (!isRouterAllowed(ctx, req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            overrides = {}
            try {
              unlinkSync(statePath)
            } catch {
              // No override file left to remove.
            }
            catalogCache.clear()
            await refresh()
            scheduleBoundary()
            writeJson(res, 200, await stateDocument())
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'reset failed' })
          }
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Route fiber already gone during shutdown.
        }
      }
    }
  }

  // ---- wiring ------------------------------------------------------------

  // A fresh agent must not spend its first step on the wrong side of the
  // boundary. Creation is a serial listener, so this stays synchronous: the
  // schedule decides, and the periodic refresh corrects against quota shortly
  // after (a network read here would delay every new session).
  ctx.on('agent/created', async ({ agent }) => {
    const s = settings()
    if (!s.enabled) return
    const target = await targetNow(s, false)
    if (target !== undefined) applyTo(agent, s, target)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    applied.delete(agent)
  })

  const disposeRoutes = registerRoutes()

  void refresh()
  scheduleBoundary()
  safetyTimer = setInterval(() => { void refresh() }, SAFETY_INTERVAL_MS)

  ctx.effect(() => () => {
    disposed = true
    applied.clear()
    if (timer !== undefined) clearTimeout(timer)
    if (safetyTimer !== undefined) clearInterval(safetyTimer)
    disposeRoutes()
  }, 'dsh-peak-router: timers')
}
