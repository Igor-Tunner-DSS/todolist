import { useState } from 'react';
import * as api from '../services/api';
import type { User } from '../types';

export default function AuthScreen({ onAuth }: { onAuth(u: User): void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { onAuth(await (mode === 'login' ? api.login : api.register)(email.trim(), password)); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="modal" onSubmit={submit} noValidate aria-label={mode === 'login' ? 'Entrar' : 'Criar conta'}>
        <h2>{mode === 'login' ? 'Entrar' : 'Criar conta'}</h2>
        <label htmlFor="a-email">E-mail</label>
        <input id="a-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
        <label htmlFor="a-pw">Senha</label>
        <input id="a-pw" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'register' ? 'Mínimo de 8 caracteres' : ''} />
        <p className="err" role="alert">{err}</p>
        <footer>
          <button type="button" className="ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>{mode === 'login' ? 'Criar conta' : 'Já tenho conta'}</button>
          <button type="submit" className="primary" disabled={busy || !email || !password}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Cadastrar'}</button>
        </footer>
      </form>
    </div>
  );
}
