import { useState, type FormEvent } from 'react'
import { apiLogin } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

export function LoginView() {
  const onLoginSuccess = useAppStore((s) => s.onLoginSuccess)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await apiLogin(username, password)
      await onLoginSuccess(res.username, res.defaultPasswordWarning)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-[#f8f8f8] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white border border-[#e5e5e5] rounded-xl p-6 shadow-sm space-y-4"
      >
        <div>
          <h1 className="text-lg font-semibold text-[#111]">MyAgents</h1>
          <p className="text-xs text-[#666] mt-1">Multi-agent server workspace (default: admin / admin)</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-[#555] mb-1">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-[#dcdcdc] rounded-lg focus:outline-none focus:border-[#c2542d]"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-[#555] mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-[#dcdcdc] rounded-lg focus:outline-none focus:border-[#c2542d]"
            />
          </div>
        </div>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

        <button
          type="submit"
          disabled={busy}
          className="w-full py-2 text-sm font-medium text-white bg-[#c2542d] hover:bg-[#ad4723] rounded-lg disabled:opacity-50 cursor-pointer"
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
