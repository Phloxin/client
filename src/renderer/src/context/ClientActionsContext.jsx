import { createContext, useContext } from 'react'

// The client action handlers + roster metadata a client context menu needs
// (poke, kick, ban, roles, groups…). Provided once by Main so a menu can be
// opened from anywhere — chat message authors, not just the sidebar — without
// threading two dozen props through everything in between.
const ClientActionsContext = createContext({})

export const ClientActionsProvider = ClientActionsContext.Provider
export function useClientActions() {
  return useContext(ClientActionsContext)
}
