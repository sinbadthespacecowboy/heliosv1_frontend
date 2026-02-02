import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SignIn from './SignIn.tsx'
import Register from './Register.tsx'
import { AuthProvider, useAuth } from './contexts/AuthContext'

// Backend URL - update this to your Jetson's IP or tunnel URL
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://10.104.2.157:8000'

function Root() {
  const { isAuthenticated, isLoading } = useAuth()
  const [showRegister, setShowRegister] = useState(false)

  if (isLoading) {
    return (
      <div className="console-shell sign-in-shell">
        <main className="sign-in-container">
          <div className="auth-box">
            <h1 className="auth-title">INITIALIZING...</h1>
          </div>
        </main>
      </div>
    )
  }

  if (!isAuthenticated) {
    if (showRegister) {
      return <Register onSwitchToSignIn={() => setShowRegister(false)} />
    }
    return <SignIn onSwitchToRegister={() => setShowRegister(true)} />
  }

  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider apiBaseUrl={API_BASE_URL}>
      <Root />
    </AuthProvider>
  </StrictMode>,
)
