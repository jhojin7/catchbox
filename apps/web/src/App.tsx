import { type FormEvent, useEffect, useState } from "react";
import type { CurrentAccount } from "@catchbox/shared";
import {
  AuthenticationApiError,
  fetchCurrentAccount,
  loginWithPassword,
} from "./auth-api";

type AuthenticationState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "signed-in"; account: CurrentAccount };

export function App() {
  const [authentication, setAuthentication] = useState<AuthenticationState>({ status: "checking" });

  useEffect(() => {
    let active = true;
    fetchCurrentAccount()
      .then((account) => {
        if (!active) return;
        setAuthentication(account ? { status: "signed-in", account } : { status: "signed-out" });
      })
      .catch(() => active && setAuthentication({ status: "signed-out" }));
    return () => {
      active = false;
    };
  }, []);

  if (authentication.status === "checking") {
    return <main className="centered" aria-busy="true">Opening Catchbox…</main>;
  }

  if (authentication.status === "signed-out") {
    return (
      <Login
        onSignedIn={(account) => setAuthentication({ status: "signed-in", account })}
      />
    );
  }

  return <ProtectedShell account={authentication.account} />;
}

function Login({ onSignedIn }: { onSignedIn(account: CurrentAccount): void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      onSignedIn(await loginWithPassword({ username, password }));
    } catch (error) {
      setError(
        error instanceof AuthenticationApiError
          ? error.message
          : "Catchbox is unavailable. Check the server and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="centered">
      <section className="card" aria-labelledby="login-title">
        <p className="eyebrow">Local capture, safely held</p>
        <h1 id="login-title">Sign in to Catchbox</h1>
        <p className="lede">Use the local account configured by your Catchbox operator.</p>
        <form onSubmit={submit}>
          <label>
            Username
            <input
              name="username"
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function ProtectedShell({ account }: { account: CurrentAccount }) {
  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">Catchbox</p>
          <h1>Capture inbox</h1>
        </div>
        <p className="identity">Signed in as {account.username}</p>
      </header>
      <section className="empty-state">
        <h2>Your capture inbox is ready</h2>
        <p>The next slice will add durable capture. This protected shell confirms your local account is working.</p>
      </section>
    </main>
  );
}
