import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface AuthContextType {
  isAuthenticated: boolean
  isLoading: boolean
  user: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  register: (username: string, email: string, password: string) => Promise<void>
  getAccessToken: () => Promise<string | null>
}

interface AuthProviderProps {
  children: ReactNode
  apiBaseUrl: string
}

const ACCESS_TOKEN_KEY = 'helios_access_token'
const REFRESH_TOKEN_KEY = 'helios_refresh_token'
const EXPIRES_AT_KEY = 'helios_expires_at'
const USER_KEY = 'helios_user'

const AuthContext = createContext<AuthContextType | null>(null)

function saveTokens(tokens: AuthTokens, username: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken)
  localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken)
  localStorage.setItem(EXPIRES_AT_KEY, tokens.expiresAt.toString())
  localStorage.setItem(USER_KEY, username)
}

function loadTokens(): { tokens: AuthTokens | null; user: string | null } {
  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY)
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
  const expiresAt = localStorage.getItem(EXPIRES_AT_KEY)
  const user = localStorage.getItem(USER_KEY)

  if (accessToken && refreshToken && expiresAt) {
    return {
      tokens: { accessToken, refreshToken, expiresAt: parseInt(expiresAt, 10) },
      user
    }
  }
  return { tokens: null, user: null }
}

function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(EXPIRES_AT_KEY)
  localStorage.removeItem(USER_KEY)
}

export function AuthProvider({ children, apiBaseUrl }: AuthProviderProps) {
  const [tokens, setTokens] = useState<AuthTokens | null>(null)
  const [user, setUser] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const { tokens: savedTokens, user: savedUser } = loadTokens()
    if (savedTokens) {
      setTokens(savedTokens)
      setUser(savedUser)
    }
    setIsLoading(false)
  }, [])

  const refreshAccessToken = useCallback(async (): Promise<AuthTokens | null> => {
    if (!tokens?.refreshToken) return null

    try {
      const response = await fetch(`${apiBaseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refreshToken })
      })

      if (!response.ok) throw new Error('Refresh failed')

      const data = await response.json()
      const newTokens: AuthTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in * 1000)
      }

      setTokens(newTokens)
      if (user) saveTokens(newTokens, user)
      return newTokens
    } catch {
      clearTokens()
      setTokens(null)
      setUser(null)
      return null
    }
  }, [tokens, user, apiBaseUrl])

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!tokens) return null

    const expiresIn = tokens.expiresAt - Date.now()
    if (expiresIn < 5 * 60 * 1000) {
      const newTokens = await refreshAccessToken()
      return newTokens?.accessToken ?? null
    }

    return tokens.accessToken
  }, [tokens, refreshAccessToken])

  const login = useCallback(async (username: string, password: string): Promise<void> => {
    const formData = new URLSearchParams()
    formData.append('username', username)
    formData.append('password', password)

    const response = await fetch(`${apiBaseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Login failed' }))
      throw new Error(error.detail || 'Invalid credentials')
    }

    const data = await response.json()
    const newTokens: AuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000)
    }

    setTokens(newTokens)
    setUser(username)
    saveTokens(newTokens, username)
  }, [apiBaseUrl])

  const register = useCallback(async (username: string, email: string, password: string): Promise<void> => {
    const response = await fetch(`${apiBaseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Registration failed' }))
      throw new Error(error.detail || 'Registration failed')
    }

    // Auto-login after registration
    await login(username, password)
  }, [apiBaseUrl, login])

  const logout = useCallback(() => {
    clearTokens()
    setTokens(null)
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{
      isAuthenticated: !!tokens,
      isLoading,
      user,
      login,
      logout,
      register,
      getAccessToken
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
