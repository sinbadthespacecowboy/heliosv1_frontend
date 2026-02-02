import { useState, type FormEvent } from 'react'
import { useAuth } from './contexts/AuthContext'
import './App.css'

type RegisterProps = {
  onSwitchToSignIn: () => void
}

function Register({ onSwitchToSignIn }: RegisterProps) {
  const { register } = useAuth()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setIsSubmitting(true)

    try {
      await register(username, email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
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
          <h1 className="auth-title">REGISTRATION</h1>

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
              type="email"
              className="auth-input"
              placeholder="[EMAIL]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              disabled={isSubmitting}
            />
            <input
              type="password"
              className="auth-input"
              placeholder="[PASSWORD]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              disabled={isSubmitting}
            />
            <input
              type="password"
              className="auth-input"
              placeholder="[CONFIRM PASSWORD]"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
              disabled={isSubmitting}
            />
            <button
              type="submit"
              className="auth-button"
              disabled={isSubmitting || !username || !email || !password || !confirmPassword}
            >
              {isSubmitting ? '[CREATING ACCOUNT...]' : '[REGISTER]'}
            </button>
          </div>

          <div className="auth-switch">
            <span>Have an account? </span>
            <button type="button" className="auth-link" onClick={onSwitchToSignIn}>
              Sign In
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}

export default Register
