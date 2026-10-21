import { useEffect, useState } from "react";
import Parse from "parse";
import { useTranslation } from "react-i18next";

export default function SecurityTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState([]);
  const [code, setCode] = useState("");
  const [users, setUsers] = useState([]);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [callerRole, setCallerRole] = useState("");
  const refresh = async () => {
    setStatus(await Parse.Cloud.run("mfaStatus"));
    const ext = await Parse.Cloud.run("getUserDetails");
    setCallerRole(ext.get("UserRole"));
    if (
      ["contracts_Admin", "contracts_OrgAdmin"].includes(ext.get("UserRole"))
    ) {
      setUsers(await Parse.Cloud.run("mfaAdminList"));
    }
    setLoaded(true);
  };
  useEffect(() => {
    refresh().catch(() => setError(t("mfa.error")));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setCode("");
      await refresh();
    } catch (e) {
      setError(
        t(
          e.message?.includes("MFA_LOCKED")
            ? "mfa.locked"
            : e.message?.includes("MFA_ADMIN_ENROLL_REQUIRED")
              ? "mfa.admin-enroll"
              : "mfa.error"
        )
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 max-w-4xl">
      <h2 className="text-lg font-semibold">
        {t("two-factor-authentication")}
      </h2>
      <p>{t("2fa-help-text")}</p>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {!loaded && !error && <p>{t("loading")}</p>}
      {status && <p>{t(status.enabled ? "mfa.enabled" : "mfa.disabled")}</p>}
      {status && !status.available && (
        <p role="alert">{t("mfa.unavailable")}</p>
      )}
      {status?.available && !status.enabled && !setup && (
        <button
          className="op-btn op-btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setCodes([]);
              setSetup(await Parse.Cloud.run("mfaSetup"));
            })
          }
        >
          {t("mfa.setup")}
        </button>
      )}
      {setup && (
        <div className="space-y-3">
          <p>{t("mfa.scan")}</p>
          <img
            src={setup.qrCode}
            alt={t("mfa.qr-alt")}
            width="220"
            height="220"
          />
          <p>
            {t("mfa.manual")}{" "}
            <code className="break-all select-all">{setup.secret}</code>
          </p>
        </div>
      )}
      {(setup || status?.enabled || target) && (
        <div className="space-y-3">
          <label className="block" htmlFor="security-code">
            {t("mfa.login-code")}
          </label>
          <input
            id="security-code"
            className="op-input op-input-bordered w-full max-w-sm"
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
            autoComplete="one-time-code"
            maxLength={24}
          />
          {setup && (
            <div className="flex gap-2">
              <button
                className="op-btn op-btn-primary"
                disabled={busy || !code}
                onClick={() =>
                  run(async () => {
                    const result = await Parse.Cloud.run("mfaEnable", { code });
                    setCodes(result.recoveryCodes);
                    setSetup(null);
                  })
                }
              >
                {t("mfa.enable")}
              </button>
              <button
                className="op-btn"
                onClick={() => {
                  setSetup(null);
                  setCode("");
                }}
              >
                {t("cancel")}
              </button>
            </div>
          )}
          {status?.enabled && (
            <button
              className="op-btn op-btn-secondary"
              disabled={busy || !code}
              onClick={() => {
                if (window.confirm(t("mfa.disable-confirm")))
                  run(async () => {
                    await Parse.Cloud.run("mfaDisable", { code });
                    setCodes([]);
                  });
              }}
            >
              {t("mfa.disable")}
            </button>
          )}
        </div>
      )}
      {codes.length > 0 && (
        <div className="border rounded p-4 space-y-3">
          <h3 className="font-semibold">{t("mfa.recovery-title")}</h3>
          <p>{t("mfa.recovery-help")}</p>
          <pre className="select-all">{codes.join("\n")}</pre>
          <button
            className="op-btn"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([`OpenSign recovery codes\n\n${codes.join("\n")}\n`], {
                  type: "text/plain"
                })
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "opensign-recovery-codes.txt";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            {t("mfa.download")}
          </button>
          <button className="op-btn ml-2" onClick={() => setCodes([])}>
            {t("mfa.saved")}
          </button>
        </div>
      )}
      {users.length > 0 && (
        <div className="space-y-3 pt-6">
          <h3 className="font-semibold">{t("mfa.admin-title")}</h3>
          <p>{t("mfa.admin-help")}</p>
          <div className="overflow-x-auto">
            <table className="op-table w-full">
              <thead>
                <tr>
                  <th>{t("name")}</th>
                  <th>{t("email")}</th>
                  <th>2FA</th>
                  <th>{t("action")}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.userId || user.email}>
                    <td>{user.name}</td>
                    <td>{user.email}</td>
                    <td>{t(user.enabled ? "mfa.enabled" : "mfa.disabled")}</td>
                    <td>
                      {user.enabled &&
                        user.userId !== Parse.User.current()?.id &&
                        user.role !== "contracts_Admin" &&
                        (callerRole === "contracts_Admin" ||
                          user.role !== "contracts_OrgAdmin") && (
                          <button
                            className="op-btn op-btn-sm"
                            disabled={busy}
                            onClick={() => setTarget(user.userId)}
                          >
                            {t("mfa.reset")}
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {target && (
            <div className="border rounded p-4 space-y-3">
              <p>
                {t("mfa.reset-confirm", {
                  email: users.find((u) => u.userId === target)?.email
                })}
              </p>
              <label htmlFor="admin-reset-code" className="block">
                {t("mfa.login-code")}
              </label>
              <input
                id="admin-reset-code"
                className="op-input op-input-bordered w-full max-w-sm"
                value={code}
                onChange={(e) => setCode(e.target.value.trim())}
                autoComplete="one-time-code"
                maxLength={24}
              />
              <button
                className="op-btn op-btn-secondary"
                disabled={busy || !code}
                onClick={() =>
                  run(async () => {
                    await Parse.Cloud.run("mfaAdminReset", {
                      userId: target,
                      code
                    });
                    setTarget("");
                  })
                }
              >
                {t("mfa.reset")}
              </button>
              <button className="op-btn ml-2" onClick={() => setTarget("")}>
                {t("cancel")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
