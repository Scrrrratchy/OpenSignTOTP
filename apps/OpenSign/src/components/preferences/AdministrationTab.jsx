import { useEffect, useState } from "react";
import Parse from "parse";
import { useTranslation } from "react-i18next";

export default function AdministrationTab() {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [kind, setKind] = useState("team");
  const refresh = async () => {
    const result = await Parse.Cloud.run("adminOverview");
    setData(result);
    setOrganizationId(
      (previous) => previous || result.organizations[0]?.id || ""
    );
  };
  useEffect(() => {
    refresh().catch(() => setError(t("admin.error")));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (params) => {
    setBusy(true);
    setError("");
    try {
      await Parse.Cloud.run("adminSave", params);
      await refresh();
      setName("");
    } catch {
      setError(t("admin.error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t("admin.title")}</h2>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {!data && !error && <p>{t("loading")}</p>}
      {data && (
        <>
          <p>{t("admin.scope-help")}</p>
          <h3 className="font-semibold">{t("admin.users")}</h3>
          <div className="overflow-x-auto">
            <table className="op-table w-full">
              <thead>
                <tr>
                  <th>{t("name")}</th>
                  <th>{t("email")}</th>
                  <th>{t("role")}</th>
                  <th>{t("admin.active")}</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => {
                  const editable =
                    user.userId !== Parse.User.current()?.id &&
                    user.role !== "contracts_Admin" &&
                    (data.role === "contracts_Admin" ||
                      user.role !== "contracts_OrgAdmin");
                  return (
                    <tr key={user.id}>
                      <td>{user.name}</td>
                      <td>{user.email}</td>
                      <td>
                        <select
                          aria-label={`${t("role")} ${user.email}`}
                          className="op-select op-select-bordered op-select-sm"
                          value={user.role}
                          disabled={busy || !editable}
                          onChange={(e) => {
                            if (window.confirm(t("admin.change-confirm")))
                              save({
                                kind: "user",
                                id: user.id,
                                role: e.target.value,
                                disabled: user.disabled
                              });
                          }}
                        >
                          {user.role === "contracts_Admin" && (
                            <option value="contracts_Admin">Admin</option>
                          )}
                          {(data.role === "contracts_Admin" ||
                            user.role === "contracts_OrgAdmin") && (
                            <option value="contracts_OrgAdmin">OrgAdmin</option>
                          )}
                          <option value="contracts_Editor">Editor</option>
                          <option value="contracts_User">User</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${t("admin.active")} ${user.email}`}
                          checked={!user.disabled}
                          disabled={busy || !editable}
                          onChange={(e) => {
                            if (window.confirm(t("admin.change-confirm")))
                              save({
                                kind: "user",
                                id: user.id,
                                role: user.role,
                                disabled: !e.target.checked
                              });
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h3 className="font-semibold">{t("admin.organizations-teams")}</h3>
          <ul>
            {data.organizations.map((org) => (
              <li key={org.id} className="mb-2">
                <strong>{org.name}</strong>
                {data.role === "contracts_Admin" && (
                  <button
                    className="op-btn op-btn-xs ml-2"
                    disabled={busy}
                    onClick={() => {
                      const value = window.prompt(t("admin.name"), org.name);
                      if (value)
                        save({ kind: "organization", id: org.id, name: value });
                    }}
                  >
                    {t("admin.rename")}
                  </button>
                )}
                <ul className="ml-5">
                  {data.teams
                    .filter((team) => team.organizationId === org.id)
                    .map((team) => (
                      <li key={team.id}>
                        {team.name}{" "}
                        <button
                          className="op-btn op-btn-xs"
                          disabled={busy}
                          onClick={() => {
                            const value = window.prompt(
                              t("admin.name"),
                              team.name
                            );
                            if (value)
                              save({
                                kind: "team",
                                id: team.id,
                                organizationId: org.id,
                                name: value,
                                active: team.active
                              });
                          }}
                        >
                          {t("admin.rename")}
                        </button>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-wrap gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              save({ kind, name, organizationId });
            }}
          >
            <select
              aria-label={t("admin.kind")}
              className="op-select op-select-bordered"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="team">{t("admin.team")}</option>
              {data.role === "contracts_Admin" && (
                <option value="organization">{t("admin.organization")}</option>
              )}
            </select>
            {kind === "team" && (
              <select
                aria-label={t("admin.organization")}
                className="op-select op-select-bordered"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                required
              >
                {data.organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            )}
            <input
              aria-label={t("admin.name")}
              placeholder={t("admin.name")}
              className="op-input op-input-bordered"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
            <button className="op-btn op-btn-primary" disabled={busy}>
              {t("admin.create")}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
