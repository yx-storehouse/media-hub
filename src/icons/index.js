/*
 * Icon set used by <Icon name="…" />.
 *   stroke: true  -> outline icon (class "ic": no fill, currentColor stroke, round caps)
 *   box           -> viewBox, defaults to "0 0 24 24"
 * Every icon is coloured through `currentColor`.
 */
const s = body => ({ stroke: true, body })
const f = body => ({ body })

export const icons = {
  search: s('<circle cx="11" cy="11" r="6.6"/><path d="m20.2 20.2-4.4-4.4"/>'),
  chevR: s('<path d="m9 5 7 7-7 7"/>'),
  chevL: s('<path d="m15 5-7 7 7 7"/>'),
  chevD: s('<path d="m5 9 7 7 7-7"/>'),
  close: s('<path d="M6 6l12 12M18 6 6 18"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  list: s('<path d="M10 6.5h11M10 12h11M10 17.5h11"/><path d="M4 6.5h.01M4 12h.01M4 17.5h.01" stroke-width="2.8"/>'),
  refresh: s('<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.8v4.6h-4.6"/>'),
  more: s('<circle cx="12" cy="12" r="9"/><path d="M8.2 12h.01M12 12h.01M15.8 12h.01" stroke-width="2.6"/>'),
  calCheck: s('<rect x="3.5" y="5" width="17" height="15.5" rx="3.2"/><path d="M8 3v4M16 3v4M3.5 10.2h17M9 15.2l2.2 2.2 4.3-4.4"/>'),
  eye: s('<path d="M1.8 12S5.6 5.2 12 5.2 22.2 12 22.2 12 18.4 18.8 12 18.8 1.8 12 1.8 12z"/><circle cx="12" cy="12" r="3"/>'),
  shareUp: s('<path d="M4.5 12.5V19a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6.5"/><path d="m16.2 7.2L12 3 7.8 7.2M12 3v12"/>'),
  bookmark: s('<path d="M18.5 21 12 16.4 5.5 21V5.2A2 2 0 0 1 7.5 3.2h9a2 2 0 0 1 2 2z"/>'),
  heart: s('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
  thumbUp: s('<path d="M14 9.2V5.2a3 3 0 0 0-3-3l-4 9.2V22h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>'),
  thumbDown: s('<path d="M10 14.8v4a3 3 0 0 0 3 3l4-9.2V2H5.7a2 2 0 0 0-2 1.7l-1.4 9a2 2 0 0 0 2 2.3zM17 2h2.7A2.3 2.3 0 0 1 22 4.3v7.4a2.3 2.3 0 0 1-2.3 2.3H17"/>'),
  shareNodes: s('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'),
  gear: s('<path d="M12 2.4 20.3 7.2v9.6L12 21.6 3.7 16.8V7.2z"/><circle cx="12" cy="12" r="3.2"/>'),
  play: f('<path d="M7.2 4.6v14.8a1 1 0 0 0 1.5.9l12-7.4a1 1 0 0 0 0-1.7l-12-7.4a1 1 0 0 0-1.5.8z" fill="currentColor"/>'),
  replay: {
    stroke: true,
    box: '0 0 32 32',
    body: '<path d="M16 5.2a10.8 10.8 0 1 1-10.8 10.8" stroke-width="1.9"/><path d="M16 1.2 11.4 5.2l4.6 4" stroke-width="1.9"/><text x="16" y="20.6" text-anchor="middle" font-size="9.6" font-weight="700" fill="currentColor" stroke="none" font-family="-apple-system,Arial,sans-serif">10</text>'
  },
  forward: {
    stroke: true,
    box: '0 0 32 32',
    body: '<path d="M16 5.2A10.8 10.8 0 1 0 26.8 16" stroke-width="1.9"/><path d="M16 1.2l4.6 4-4.6 4" stroke-width="1.9"/><text x="16" y="20.6" text-anchor="middle" font-size="9.6" font-weight="700" fill="currentColor" stroke="none" font-family="-apple-system,Arial,sans-serif">10</text>'
  },
  /* video player */
  // 长按快进的提示（双箭头）
  ffwd: s('<path d="m4.5 6 6 6-6 6M12.5 6l6 6-6 6"/>'),
  pause: f('<rect x="6" y="4.6" width="4.2" height="14.8" rx="1.2" fill="currentColor"/><rect x="13.8" y="4.6" width="4.2" height="14.8" rx="1.2" fill="currentColor"/>'),
  cog: s('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
  loop: s('<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>'),
  fullscreen: s('<path d="M3.5 8.5v-5h5M15.5 3.5h5v5M20.5 15.5v5h-5M8.5 20.5h-5v-5"/>'),
  fullscreenExit: s('<path d="M8.5 3.5v5h-5M20.5 8.5h-5v-5M15.5 20.5v-5h5M3.5 15.5h5v5"/>'),
  expand: s('<path d="M10.5 3.5h-7v7M3.5 3.5l7 7M13.5 20.5h7v-7M20.5 20.5l-7-7"/>'),
  pip: s('<path d="M12 5H5.5A2.5 2.5 0 0 0 3 7.5v8A2.5 2.5 0 0 0 5.5 18H11"/><path d="M13 5h5.5A2.5 2.5 0 0 1 21 7.5V10"/><rect x="11.5" y="11.5" width="9.5" height="8" rx="2" fill="currentColor" stroke="none"/><path d="m6.5 8.5 3.6 3.6M6.5 8.5v3M6.5 8.5h3" stroke-width="1.7"/>'),
  mute: s('<path d="M3.5 9.6h3.8l5.2-4.4v13.6l-5.2-4.4H3.5z" fill="currentColor"/><path d="m4 3.6 16.4 16.8" stroke-width="2.2"/><path d="M16.6 9.2a4.2 4.2 0 0 1 0 5.6"/>'),
  vol: s('<path d="M3.5 9.6h3.8l5.2-4.4v13.6l-5.2-4.4H3.5z" fill="currentColor"/><path d="M16.4 8.8a4.6 4.6 0 0 1 0 6.4M19.2 6a8.6 8.6 0 0 1 0 12"/>'),
  history: s('<circle cx="12" cy="12" r="9.4"/><path d="M12 6.8V12l3.2 2.2" stroke-width="2.2"/>'),
  library: s('<rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.4"/><path d="M8.6 4.6v14.8M15.4 4.6v14.8M2.6 9.6h4M2.6 14.4h4M17.4 9.6h4M17.4 14.4h4" stroke-width="1.8"/>'),
  flame: { box: '0 0 24 28', body: '<path d="M12.6 1.2c.7 4.6 6.8 7.4 7.2 14.2a8 8 0 0 1-15.9.9C3.7 13 5 11 6.7 9.3c.2 2.1 1.1 3.3 2.2 4 .1-5.2 1.6-9.6 3.7-12.1z" fill="currentColor"/>' },
  verified: f('<path d="M12 1.6l2.5 1.7 3-.2 1.3 2.7 2.7 1.3-.2 3L22.9 12l-1.6 2.5.2 3-2.7 1.3-1.3 2.7-3-.2L12 22.9l-2.5-1.6-3 .2-1.3-2.7-2.7-1.3.2-3L1.1 12l1.6-2.5-.2-3 2.7-1.3 1.3-2.7 3 .2z" fill="#fff"/><path d="m7.6 12.3 3 3 5.8-6" fill="none" stroke="#0a0a0a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),

  /* bottom tab bar: outline + filled (active) */
  tHome: s('<path d="M3.6 11.2 12 3.6l8.4 7.6M5.6 9.8V20a1 1 0 0 0 1 1h3.4v-5.4h4V21h3.4a1 1 0 0 0 1-1V9.8"/>'),
  tHomeOn: f('<path d="M12 2.6 1.9 11.4a.8.8 0 0 0 .5 1.4H4.4V20a1.4 1.4 0 0 0 1.4 1.4h3.8a.6.6 0 0 0 .6-.6v-4.3a1.6 1.6 0 0 1 1.6-1.6h.4a1.6 1.6 0 0 1 1.6 1.6v4.3a.6.6 0 0 0 .6.6h3.8a1.4 1.4 0 0 0 1.4-1.4v-7.2h2a.8.8 0 0 0 .5-1.4z" fill="currentColor"/>'),
  tShort: s('<rect x="3" y="3" width="18" height="18" rx="4.4"/><path d="M10 8.4v7.2l5.6-3.6z"/>'),
  /* the active icons cut real holes (evenodd) so whatever is behind shows through */
  tShortOn: f('<path fill-rule="evenodd" fill="currentColor" d="M7 2.6h10A4.4 4.4 0 0 1 21.4 7v10a4.4 4.4 0 0 1-4.4 4.4H7A4.4 4.4 0 0 1 2.6 17V7A4.4 4.4 0 0 1 7 2.6zM9.6 7.8v8.4l7-4.2z"/>'),
  tLive: s('<rect x="2" y="5.4" width="14" height="13.2" rx="3.2"/><path d="m16 10.4 5.4-3.3v9.8L16 13.6"/>'),
  tLiveOn: f('<rect x="1.8" y="5" width="14.4" height="14" rx="3.4" fill="currentColor"/><path d="m22.2 7.6-4.6 3.4v2l4.6 3.4z" fill="currentColor"/>'),
  tCommunity: s('<circle cx="9" cy="7.6" r="3.4"/><circle cx="17.2" cy="9.4" r="2.5"/><path d="M2.6 20v-1.2a5 5 0 0 1 5-5h2.8a5 5 0 0 1 5 5V20"/><path d="M17.6 13.8a4.2 4.2 0 0 1 3.8 4.2v1.6"/>'),
  tCommunityOn: f('<circle cx="9" cy="7.6" r="3.8" fill="currentColor"/><circle cx="17.2" cy="9.4" r="2.8" fill="currentColor"/><path d="M1.8 20.2v-1.6a5.4 5.4 0 0 1 5.4-5.4h3.6a5.4 5.4 0 0 1 5.4 5.4v1.6z" fill="currentColor"/><path d="M17.4 13.4a4.6 4.6 0 0 1 4.8 4.6v2.2h-4.4v-2a7.4 7.4 0 0 0-1.5-4.4z" fill="currentColor"/>'),
  tNearby: s('<path d="M12 21.4s-7.2-6.1-7.2-11.6a7.2 7.2 0 0 1 14.4 0c0 5.5-7.2 11.6-7.2 11.6z"/><circle cx="12" cy="9.8" r="2.5"/>'),
  tNearbyOn: f('<path fill-rule="evenodd" fill="currentColor" d="M12 1.8a8 8 0 0 0-8 8c0 5.6 6.2 11.2 7.2 12a1.3 1.3 0 0 0 1.6 0c1-.8 7.2-6.4 7.2-12a8 8 0 0 0-8-8zM12 6.9a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 1 0 0-5.8z"/>'),
  tMe: s('<circle cx="12" cy="7.8" r="4.1"/><path d="M4.6 21v-1.2a5.2 5.2 0 0 1 5.2-5.2h4.4a5.2 5.2 0 0 1 5.2 5.2V21"/>'),
  tMeOn: f('<circle cx="12" cy="7.6" r="4.4" fill="currentColor"/><path d="M3.6 21.2v-1a6 6 0 0 1 6-6h4.8a6 6 0 0 1 6 6v1z" fill="currentColor"/>'),

  /* me page */
  iHistory: s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.8"/>'),
  iDownload: s('<path d="M4.5 15v4a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4M12 3v12M7.6 10.6 12 15l4.4-4.4"/>'),
  iMsg: s('<path d="M21 12a8.5 8.5 0 0 1-12.4 7.5L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/>'),
  iHelp: s('<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.6 2.5c-.7.3-1 .8-1 1.6M12 17h.01"/>'),
  iInfo: s('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6h.01"/>'),
  /* password field */
  lock: s('<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.6v2.6"/>')
}
