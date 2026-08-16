import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession, resolvePostLoginPath } from "@/state/session";
import { Button, Card, Input } from "@/components/ui";
import { env } from "@/env";

export function Login() {
  const navigate = useNavigate();
  const signIn = useSession((s) => s.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await signIn(email.trim(), password);
    setLoading(false);
    if (error) return setError(error);
    navigate(resolvePostLoginPath(useSession.getState()), { replace: true });
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-2xl font-black text-onbrand">B</div>
          <h1 className="text-2xl font-extrabold text-brand-dark">Breadee</h1>
          <p className="text-xs font-semibold text-sub">From Ingredients To Profit · Desktop</p>
        </div>
        <Card className="p-7">
          <h2 className="text-lg font-extrabold">Welcome back</h2>
          <p className="mt-1 text-sm text-sub">Sign in to your Breadee account</p>
          <form onSubmit={onSubmit} className="mt-5 space-y-3">
            <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            <div className="relative">
              <Input
                type={show ? "text" : "password"}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-2.5 text-xs font-semibold text-sub">
                {show ? "Hide" : "Show"}
              </button>
            </div>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-[11px] text-slate-400">
          {env.APP_NAME} Desktop · {env.APP_ENV} · connected to staging Supabase
        </p>
      </div>
    </div>
  );
}
