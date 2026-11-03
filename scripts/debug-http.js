(async () => {
  const out = {
    hasCaldesk: typeof window.caldesk,
    hasHttpCfg: typeof window.__CALDESK_HTTP__,
    cfg: window.__CALDESK_HTTP__ ?? null
  }
  try {
    const r = await fetch('http://127.0.0.1:8787/api/calendars', {
      headers: { authorization: 'Bearer dev-token-123' }
    })
    out.status = r.status
    out.body = (await r.text()).slice(0, 120)
  } catch (e) {
    out.fetchError = e.message
  }
  out.cardCount = document.querySelectorAll('.cal-item').length
  return JSON.stringify(out)
})()
