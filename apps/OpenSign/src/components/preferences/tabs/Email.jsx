import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";
import MailTemplateEditor from "../MailTemplateEditor";
import { useState } from "react";
import Parse from "parse";
import Alert from "../../../primitives/Alert";

const EmailTab = () => {
  const { t } = useTranslation();
  const {
    tenantInfo
  } = useSelector((state) => state.user);
  const [testResult, setTestResult] = useState({ type: "", message: "" });
  const [testing, setTesting] = useState(false);
  const testMail = async () => {
    setTesting(true);
    setTestResult({ type: "", message: "" });
    try {
      const result = await Parse.Cloud.run("testMailConfiguration");
      setTestResult({ type: "success", message: `Test email sent to ${result.recipient}` });
    } catch (err) {
      setTestResult({ type: "danger", message: err.message });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="flex flex-col mb-4">
        <div className="flex items-center justify-between gap-3 px-3 pb-3 border-b border-base-300">
          <div>
            <h3 className="font-semibold">Mail provider</h3>
            <p className="text-xs text-base-content/70">Send a real delivery test to your administrator address.</p>
          </div>
          <button type="button" className="op-btn op-btn-secondary op-btn-sm" disabled={testing} onClick={testMail}>
            <i className="fa-light fa-paper-plane mr-1"></i>
            {testing ? t("loading") : "Send test"}
          </button>
        </div>
        {testResult.message && <div className="m-3"><Alert type={testResult.type}>{testResult.message}</Alert></div>}
        <MailTemplateEditor
          info={
                tenantInfo
          }
          tenantId={tenantInfo?.objectId}
        />
    </div>
  );
};

export default EmailTab;
