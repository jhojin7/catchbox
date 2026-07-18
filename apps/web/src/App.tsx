import { type FormEvent, useEffect, useState } from "react";
import type { CaptureListItem, CurrentAccount } from "@catchbox/shared";
import {
  AuthenticationApiError,
  fetchCurrentAccount,
  loginWithPassword,
  logoutCurrentSession,
} from "./auth-api";
import { CaptureApiError, fetchCaptureInbox } from "./capture-api";
import {
  authorizeOfflineAccount,
  clearOfflineAuthorization,
  discardFailedCapture,
  drainPendingCaptures,
  listLocalCaptures,
  loadOfflineAuthorizedAccount,
  nextPendingCaptureAttempt,
  OUTBOX_SYNC_TAG,
  retryFailedCapture,
  savePendingTextCapture,
  type LocalCaptureItem,
} from "./local-captures";

type AuthenticationState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "signed-in"; account: CurrentAccount };

export function App() {
  const [authentication, setAuthentication] = useState<AuthenticationState>({ status: "checking" });

  useEffect(() => {
    let active = true;
    async function restoreAuthentication() {
      let account: CurrentAccount | undefined;
      try {
        account = await fetchCurrentAccount();
      } catch {
        const offlineAccount = await loadOfflineAuthorizedAccount().catch(() => undefined);
        if (!active) return;
        setAuthentication(
          offlineAccount
            ? { status: "signed-in", account: offlineAccount }
            : { status: "signed-out" },
        );
        return;
      }

      if (!account) {
        await clearOfflineAuthorization().catch(() => undefined);
        if (active) setAuthentication({ status: "signed-out" });
        return;
      }
      await authorizeOfflineAccount(account).catch(async () => {
        await clearOfflineAuthorization().catch(() => undefined);
      });
      if (active) setAuthentication({ status: "signed-in", account });
    }

    void restoreAuthentication();
    return () => {
      active = false;
    };
  }, []);

  async function revokeOfflineAccess() {
    await clearOfflineAuthorization();
    setAuthentication({ status: "signed-out" });
  }

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

  return <ProtectedShell account={authentication.account} onSignedOut={revokeOfflineAccess} />;
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
      const account = await loginWithPassword({ username, password });
      await authorizeOfflineAccount(account);
      onSignedIn(account);
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

function ProtectedShell({
  account,
  onSignedOut,
}: {
  account: CurrentAccount;
  onSignedOut(): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [captures, setCaptures] = useState<VisibleCapture[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [offline, setOffline] = useState(!navigator.onLine);
  const [signingOut, setSigningOut] = useState(false);
  const [recoveringItemId, setRecoveringItemId] = useState<string>();
  const [syncGeneration, setSyncGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    async function refreshAndDrain() {
      const result = await synchronizeCaptures(account.id);
      if (!active) return;
      if (result.status === "authentication-required") {
        await onSignedOut();
        return;
      }
      setCaptures(result.captures);
      setOffline(result.offline);
      setError(undefined);
      setLoading(false);
      const nextAttemptAt = await nextPendingCaptureAttempt(account.id);
      if (active && nextAttemptAt) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(
          () => void refreshAndDrain(),
          Math.max(0, new Date(nextAttemptAt).getTime() - Date.now()) + 10,
        );
      }
    }

    void listLocalCaptures(account.id).then((local) => {
      if (active) setCaptures(mergeCaptures(local, []));
    });
    void refreshAndDrain();
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [account.id, syncGeneration]);

  useEffect(() => {
    const requestSynchronization = () => setSyncGeneration((generation) => generation + 1);
    window.addEventListener("online", requestSynchronization);
    return () => window.removeEventListener("online", requestSynchronization);
  }, [account.id]);

  async function capture(event: FormEvent) {
    event.preventDefault();
    const capturedText = text.trim();
    if (!capturedText) return;

    setSubmitting(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const persistedItem = await savePendingTextCapture(account.id, capturedText);
      setCaptures((current) => [
        persistedItem,
        ...current.filter((item) => item.clientItemId !== persistedItem.clientItemId),
      ]);
      setText("");
      setNotice("Capture saved locally");
      void requestBackgroundSync();
      setSyncGeneration((generation) => generation + 1);
    } catch {
      setError("The capture could not be saved on this device.");
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    setError(undefined);
    try {
      await logoutCurrentSession();
      await onSignedOut();
    } catch (error) {
      if (
        error instanceof AuthenticationApiError &&
        error.code === "AUTHENTICATION_REQUIRED"
      ) {
        await onSignedOut();
        return;
      }
      setError("Catchbox could not sign out. Check the server and try again.");
      setSigningOut(false);
    }
  }

  async function retryCapture(clientItemId: string) {
    setRecoveringItemId(clientItemId);
    try {
      if (!(await retryFailedCapture(account.id, clientItemId))) return;
      setCaptures((current) =>
        current.map((capture) =>
          capture.clientItemId === clientItemId
            ? { ...capture, syncStatus: "pending" }
            : capture,
        ),
      );
      setSyncGeneration((generation) => generation + 1);
    } finally {
      setRecoveringItemId(undefined);
    }
  }

  async function discardCapture(clientItemId: string) {
    if (!window.confirm("Discard this failed local capture? This cannot be undone.")) return;
    setRecoveringItemId(clientItemId);
    try {
      if (await discardFailedCapture(account.id, clientItemId)) {
        setCaptures((current) =>
          current.filter((capture) => capture.clientItemId !== clientItemId),
        );
      }
    } finally {
      setRecoveringItemId(undefined);
    }
  }

  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">Catchbox</p>
          <h1>Capture inbox</h1>
        </div>
        <div className="account-actions">
          <p className="identity">Signed in as {account.username}</p>
          <button type="button" className="secondary" onClick={signOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>
      <div className="inbox-layout">
        <section className="quick-capture card" aria-labelledby="quick-capture-title">
          <p className="eyebrow">New item</p>
          <h2 id="quick-capture-title">Quick capture</h2>
          <p className="connection-note">
            {offline
              ? "Working offline. Pending captures will sync when Catchbox reconnects."
              : "Saved on this device first, then synchronized with Catchbox."}
          </p>
          <form onSubmit={capture}>
            <label htmlFor="capture-text">Capture text</label>
            <textarea
              id="capture-text"
              name="text"
              rows={6}
              maxLength={50_000}
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
                <li
                  className="capture-item"
                  key={item.clientItemId}
                  data-client-item-id={item.clientItemId}
                >
                  <p>{item.text}</p>
                  <div className="capture-meta">
                    <span className={`sync-status ${item.syncStatus}`} aria-live="polite">
                      {item.syncStatus === "pending"
                        ? "Pending"
                        : item.syncStatus === "failed"
                          ? "Failed"
                          : "Synced"}
                    </span>
                    <time dateTime={item.receivedAt ?? item.capturedAt}>
                      {new Date(item.receivedAt ?? item.capturedAt).toLocaleString()}
                    </time>
                  </div>
                  {item.syncStatus === "failed" && (
                    <div className="outbox-recovery">
                      <p className="outbox-error">{item.lastErrorDetail}</p>
                      <div className="outbox-actions">
                        <button
                          type="button"
                          onClick={() => void retryCapture(item.clientItemId)}
                          disabled={recoveringItemId === item.clientItemId}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          className="danger-secondary"
                          onClick={() => void discardCapture(item.clientItemId)}
                          disabled={recoveringItemId === item.clientItemId}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}

interface VisibleCapture {
  clientItemId: string;
  text: string;
  syncStatus: LocalCaptureItem["syncStatus"];
  capturedAt: string;
  receivedAt?: string;
  lastErrorCode?: LocalCaptureItem["lastErrorCode"];
  lastErrorDetail?: string;
}

async function synchronizeCaptures(accountId: string) {
  try {
    await drainPendingCaptures({ accountId });
  } catch (error) {
    if (error instanceof CaptureApiError && error.code === "AUTHENTICATION_REQUIRED") {
      return { status: "authentication-required" } as const;
    }
    throw error;
  }
  const local = await listLocalCaptures(accountId);
  try {
    const remote = (await fetchCaptureInbox()).captures;
    return { captures: mergeCaptures(local, remote), offline: false };
  } catch (error) {
    if (error instanceof CaptureApiError && error.code === "AUTHENTICATION_REQUIRED") {
      return { status: "authentication-required" } as const;
    }
    return { captures: mergeCaptures(local, []), offline: true };
  }
}

function mergeCaptures(local: LocalCaptureItem[], remote: CaptureListItem[]) {
  const byClientItemId = new Map<string, VisibleCapture>();
  for (const item of remote) {
    byClientItemId.set(item.clientItemId, {
      clientItemId: item.clientItemId,
      text: item.text,
      syncStatus: "synced",
      capturedAt: item.capturedAt,
      receivedAt: item.receivedAt,
    });
  }
  for (const item of local) byClientItemId.set(item.clientItemId, item);
  return [...byClientItemId.values()].sort((left, right) => {
    const timeOrder = (right.receivedAt ?? right.capturedAt).localeCompare(
      left.receivedAt ?? left.capturedAt,
    );
    return timeOrder || right.clientItemId.localeCompare(left.clientItemId);
  });
}

async function requestBackgroundSync() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    const backgroundSync = registration as ServiceWorkerRegistration & {
      sync?: { register(tag: string): Promise<void> };
    };
    await backgroundSync.sync?.register(OUTBOX_SYNC_TAG);
  } catch {
    // Foreground startup and online events remain the portable sync path.
  }
}
