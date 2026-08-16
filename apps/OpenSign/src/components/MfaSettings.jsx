import { useEffect, useState } from "react";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import SecurityOutlined from "@mui/icons-material/SecurityOutlined";
import ShieldOutlined from "@mui/icons-material/ShieldOutlined";
import Parse from "parse";
import { useTranslation } from "react-i18next";
import Alert from "../primitives/Alert";
import Loader from "../primitives/Loader";
import ModalUi from "../primitives/ModalUi";

export default function MfaSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState({
    enabled: false,
    recoveryCodesRemaining: 0
  });
  const [setup, setSetup] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [mode, setMode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      setStatus(await Parse.Cloud.run("getMfaStatus"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const beginSetup = async () => {
    setLoading(true);
    setError("");
    try {
      setSetup(await Parse.Cloud.run("beginMfaSetup"));
      setMode("setup");
      setCode("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const confirmSetup = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await Parse.Cloud.run("confirmMfaSetup", { token: code });
      setStatus({
        enabled: true,
        recoveryCodesRemaining: result.recoveryCodes.length
      });
      setRecoveryCodes(result.recoveryCodes);
      setMode("recovery");
      setCode("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const disable = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await Parse.Cloud.run(
        "disableMfa",
        useRecovery ? { recoveryCode: code } : { token: code }
      );
      setStatus({ enabled: false, recoveryCodesRemaining: 0 });
      closeModal();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const downloadRecoveryCodes = () => {
    const blob = new Blob([recoveryCodes.join("\n") + "\n"], {
      type: "text/plain"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "opensign-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  const copySecret = async () => {
    await navigator.clipboard.writeText(setup.secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const closeModal = () => {
    setMode(null);
    setSetup(null);
    setRecoveryCodes([]);
    setCode("");
    setUseRecovery(false);
    setError("");
    setCopied(false);
  };

  return (
    <section className="bg-base-100 text-base-content border border-base-300 shadow-sm rounded-lg w-full overflow-hidden">
      <div className="p-5 sm:p-6">
        <div>
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <SecurityOutlined fontSize="small" />
            </div>
            <h2 className="font-semibold text-base leading-6 flex-1 min-w-[150px]">
              {t("two-factor-authentication")}
            </h2>
            <span
              className={`ml-[52px] sm:ml-auto shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold rounded-full px-2.5 py-1 ${
                status.enabled
                  ? "bg-success/10 text-success"
                  : "bg-base-200 text-base-content/65"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${status.enabled ? "bg-success" : "bg-base-content/35"}`}
              />
              {status.enabled ? t("2fa-enabled") : t("2fa-disabled")}
            </span>
          </div>
          <p className="text-sm leading-5 text-base-content/65 mt-3">
            {t("2fa-help-text")}
          </p>
        </div>

        {error && !mode && (
          <div className="mt-4">
            <Alert type="danger">{error}</Alert>
          </div>
        )}

        {status.enabled && !loading && (
          <div className="mt-5 py-4 border-y border-base-300 flex items-center gap-3">
            <div className="w-9 h-9 shrink-0 rounded-lg bg-base-200 flex items-center justify-center font-semibold">
              {status.recoveryCodesRemaining}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("recovery-codes")}</p>
              <p className="text-xs text-base-content/60 mt-0.5">
                {t("use-recovery-code-instead")}
              </p>
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            className={`op-btn op-btn-sm ${status.enabled ? "op-btn-outline op-btn-error" : "op-btn-primary"}`}
            disabled={loading}
            onClick={status.enabled ? () => setMode("disable") : beginSetup}
          >
            <ShieldOutlined fontSize="small" />
            <span className="capitalize">
              {status.enabled ? t("deactivate") : t("setup-2fa")}
            </span>
          </button>
          {loading && !mode && <Loader />}
        </div>
      </div>

      <ModalUi
        isOpen={Boolean(mode)}
        title={t("two-factor-authentication")}
        handleClose={closeModal}
        isLoader={loading}
        showScrollBar
      >
        {error && (
          <div className="mx-5 mt-3">
            <Alert type="danger">{error}</Alert>
          </div>
        )}
        {mode === "setup" && setup && (
          <form onSubmit={confirmSetup} className="p-5 pt-3">
            <p className="text-sm text-base-content/75 mb-4">
              {t("scan-qr-instructions")}
            </p>
            <div className="grid md:grid-cols-[240px_minmax(0,1fr)] gap-5 items-start">
              <div className="w-[240px] max-w-full aspect-square mx-auto bg-white border border-base-300 rounded-lg p-2">
                <img
                  src={setup.qrCode}
                  alt={t("scan-qr-code")}
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-base-content/65">
                  {t("manual-setup-instructions")}
                </p>
                <div className="flex items-center gap-2 bg-base-200 border border-base-300 p-2.5 mt-2 rounded-lg">
                  <code className="font-mono text-sm break-all flex-1">
                    {setup.secret}
                  </code>
                  <button
                    type="button"
                    className="op-btn op-btn-ghost op-btn-sm op-btn-square shrink-0"
                    title={copied ? t("copied") : t("copy-to-clipboard")}
                    onClick={copySecret}
                  >
                    <ContentCopyOutlined fontSize="small" />
                  </button>
                </div>
                <label
                  htmlFor="mfa-setup-code"
                  className="block text-sm font-semibold mt-5 mb-1.5"
                >
                  {t("verification-code")}
                </label>
                <input
                  id="mfa-setup-code"
                  className="op-input op-input-bordered w-full font-mono tracking-widest"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, ""))
                  }
                />
                <button
                  type="submit"
                  className="op-btn op-btn-primary mt-4 w-full"
                >
                  {t("verify")}
                </button>
              </div>
            </div>
          </form>
        )}
        {mode === "recovery" && (
          <div className="p-5 pt-3">
            <p className="text-sm text-base-content/75">
              {t("recovery-codes-instructions")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 my-4 font-mono text-center">
              {recoveryCodes.map((item) => (
                <span
                  key={item}
                  className="bg-base-200 border border-base-300 p-2 rounded-lg"
                >
                  {item}
                </span>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                className="op-btn op-btn-primary flex-1"
                onClick={downloadRecoveryCodes}
              >
                <DownloadOutlined fontSize="small" />
                {t("download-recovery-codes")}
              </button>
              <button
                type="button"
                className="op-btn op-btn-ghost"
                onClick={closeModal}
              >
                {t("close")}
              </button>
            </div>
          </div>
        )}
        {mode === "disable" && (
          <form onSubmit={disable} className="p-5 pt-3">
            <p className="text-sm text-base-content/75 mb-4">
              {t("delete-two-factor-authentication")}
            </p>
            <label
              htmlFor="mfa-disable-code"
              className="block text-sm font-semibold mb-1.5"
            >
              {useRecovery ? t("recovery-code") : t("verification-code")}
            </label>
            <input
              id="mfa-disable-code"
              className="op-input op-input-bordered w-full font-mono"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <button
              type="button"
              className="op-link op-link-primary text-xs mt-2"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setCode("");
              }}
            >
              {useRecovery
                ? t("use-verification-code-instead")
                : t("use-recovery-code-instead")}
            </button>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                className="op-btn op-btn-ghost"
                onClick={closeModal}
              >
                {t("cancel")}
              </button>
              <button type="submit" className="op-btn op-btn-error capitalize">
                {t("deactivate")}
              </button>
            </div>
          </form>
        )}
      </ModalUi>
    </section>
  );
}
