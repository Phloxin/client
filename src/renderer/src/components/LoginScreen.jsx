import './LoginScreen.css'

function LoginScreen({
  username,
  password,
  onUsernameChange,
  onPasswordChange,
  onLogin,
  loginError
}) {
  return (
    <div className="login-screen">
      <div className="login-box">
        <div className="login-title">Pylon</div>
        <div className="admin-section">
          <label>Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            placeholder="Enter username"
            onKeyDown={(e) => e.key === 'Enter' && onLogin()}
          />
        </div>
        <div className="admin-section">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="Enter password"
            onKeyDown={(e) => e.key === 'Enter' && onLogin()}
          />
        </div>
        <button className="login-btn" onClick={onLogin}>
          Login
        </button>
        {loginError && (
          <div className="admin-status" style={{ color: '#ed4245' }}>
            {loginError}
          </div>
        )}
      </div>
    </div>
  )
}

export default LoginScreen
