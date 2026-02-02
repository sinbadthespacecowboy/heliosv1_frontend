import { useState, type FormEvent } from 'react'
import { useAuth } from './contexts/AuthContext'
import './App.css'

type SignInProps = {
  onSwitchToRegister: () => void
}

function SignIn({ onSwitchToRegister }: SignInProps) {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)

    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="console-shell sign-in-shell">
      <header className="sign-in-header">
        <div className="brand-lockup">
          <img src="/world.svg" alt="Narsil Systems logo" className="brand-logo" />
        </div>
      </header>

      <main className="sign-in-container">
        <form className="auth-box" onSubmit={handleSubmit}>
          <h1 className="auth-title">AUTHENTICATION</h1>

          {error && (
            <div className="auth-error">
              {error}
            </div>
          )}

          <div className="auth-fields">
            <input
              type="text"
              className="auth-input"
              placeholder="[USERNAME]"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              disabled={isSubmitting}
            />
            <input
              type="password"
              className="auth-input"
              placeholder="[PASSWORD]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={isSubmitting}
            />
            <button
              type="submit"
              className="auth-button"
              disabled={isSubmitting || !username || !password}
            >
              {isSubmitting ? '[AUTHENTICATING...]' : '[SIGN IN]'}
            </button>
          </div>

          <div className="auth-switch">
            <span>No account? </span>
            <button type="button" className="auth-link" onClick={onSwitchToRegister}>
              Register
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}

export default SignIn
