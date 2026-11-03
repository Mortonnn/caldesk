import type { CaldeskApi } from './index'

declare global {
  interface Window {
    caldesk: CaldeskApi
  }
}

export {}
