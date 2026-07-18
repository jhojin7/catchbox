import { type FormEvent, useEffect, useState } from "react";
import type { CaptureListItem, CurrentAccount } from "@catchbox/shared";
import {
  AuthenticationApiError,
  fetchCurrentAccount,
  loginWithPassword,
} from "./auth-api";
import { fetchCaptureInbox, submitTextCapture } from "./capture-api";

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
  const [text, setText] = useState("");
  const [captures, setCaptures] = useState<CaptureListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    fetchCaptureInbox()
      .then((page) => active && setCaptures(page.captures))
      .catch(() => active && setError("The inbox could not be loaded. Try reloading Catchbox."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  async function capture(event: FormEvent) {
    event.preventDefault();
    const capturedText = text.trim();
    if (!capturedText) return;

    setSubmitting(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const clientBatchId = crypto.randomUUID();
      const clientItemId = crypto.randomUUID();
      const capturedAt = new Date().toISOString();
      const result = await submitTextCapture({
        clientBatchId,
        capturedAt,
        source: { platform: "web", app: "catchbox-pwa" },
        items: [
          {
            clientItemId,
            type: "text",
            text: capturedText,
          },
        ],
      });
      const persistedItem: CaptureListItem = {
        id: result.items[0].id,
        batchId: result.batch.id,
        clientItemId: result.items[0].clientItemId,
        type: "text",
        text: capturedText,
        state: result.items[0].state,
        capturedAt: result.batch.capturedAt,
        receivedAt: result.batch.receivedAt,
      };
      setCaptures((current) => [
        persistedItem,
        ...current.filter((item) => item.id !== persistedItem.id),
      ]);
      setText("");
      setNotice("Capture saved");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The capture could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">Catchbox</p>
          <h1>Capture inbox</h1>
        </div>
        <p className="identity">Signed in as {account.username}</p>
      </header>
      <div className="inbox-layout">
        <section className="quick-capture card" aria-labelledby="quick-capture-title">
          <p className="eyebrow">New item</p>
          <h2 id="quick-capture-title">Quick capture</h2>
          <p className="connection-note">
            Requires a live connection. Offline saving and retry are not available yet.
          </p>
          <form onSubmit={capture}>
            <label htmlFor="capture-text">Capture text</label>
            <textarea
              id="capture-text"
              name="text"
              rows={6}
              required
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="What do you want to remember?"
            />
            <button type="submit" disabled={submitting || text.trim().length === 0}>
              {submitting ? "Saving…" : "Save capture"}
            </button>
          </form>
          {notice && <p className="success" role="status">{notice}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </section>

        <section className="inbox" aria-labelledby="inbox-title" aria-busy={loading}>
          <div className="section-heading">
            <p className="eyebrow">Newest first</p>
            <h2 id="inbox-title">Inbox</h2>
          </div>
          {loading ? (
            <p className="inbox-message">Loading captures…</p>
          ) : captures.length === 0 ? (
            <div className="empty-state">
              <h3>No captures yet</h3>
              <p>Your saved text will appear here immediately.</p>
            </div>
          ) : (
            <ol className="capture-list">
              {captures.map((item) => (
                <li className="capture-item" key={item.id}>
                  <p>{item.text}</p>
                  <time dateTime={item.receivedAt}>
                    {new Date(item.receivedAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
