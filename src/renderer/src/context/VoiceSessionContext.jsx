import { createContext, useContext } from 'react'

// The live voice session (lib/useVoiceSessionOwner). Provided once by Main so
// anything under it can join, switch, leave, share and observe the session for
// any channel id, whether or not the sidebar renders a row for that channel.
const VoiceSessionContext = createContext(null)

export const VoiceSessionProvider = VoiceSessionContext.Provider
export function useVoiceSession() {
  return useContext(VoiceSessionContext)
}
