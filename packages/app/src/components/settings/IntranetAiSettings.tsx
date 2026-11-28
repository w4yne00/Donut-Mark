import { useEffect, useState } from "react";
import type { AppAiRuntime, IntranetAiConfig } from "../../runtime";
import { SettingsButton, SettingsRow, SettingsSection, SettingsTextInput } from "./SettingsControls";
import type { SettingsTranslate } from "./translate";

export function IntranetAiSettings({ service, translate }: {
  service: NonNullable<AppAiRuntime["intranet"]>;
  translate: SettingsTranslate;
}) {
  const [config, setConfig] = useState<IntranetAiConfig>({ baseUrl: "", model: "", apiKey: "" });
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    service.getConfig().then((config) => {
      if (active) setConfig(config);
    }).catch(() => {
      if (active) setError(translate("settings.ai.intranetLoadFailed"));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [service, translate]);

  const save = () => {
    setBusy(true);
    setSaved(false);
    setError("");
    service.saveConfig(config).then((savedConfig) => {
      setConfig(savedConfig);
      setSaved(true);
    }).catch(() => setError(translate("settings.ai.intranetSaveFailed")))
      .finally(() => setBusy(false));
  };

  const fields = [
    { key: "baseUrl", label: translate("settings.ai.apiAddress"), placeholder: "http://model-host:8000/v1" },
    { key: "model", label: translate("settings.ai.modelId") },
    { key: "apiKey", label: translate("settings.ai.apiKey"), description: translate("settings.ai.intranetOptionalKey") }
  ] as const;

  return (
    <SettingsSection label={translate("settings.sections.aiProviders")}>
      <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
        {fields.map(({ key, label, ...field }) => (
          <SettingsRow key={key} title={label} description={"description" in field ? field.description : undefined} action={
            <SettingsTextInput
              label={label}
              placeholder={"placeholder" in field ? field.placeholder : undefined}
              type={key === "apiKey" ? "password" : "text"}
              value={config[key]}
              widthClassName="w-72 max-w-full"
              onChange={(value) => {
                setConfig((current) => ({ ...current, [key]: value }));
                setSaved(false);
                setError("");
              }}
            />
          } />
        ))}
        <SettingsRow title={translate("settings.ai.intranetClearDescription")} action={
          <SettingsButton disabled={busy} label={translate("settings.ai.saveProviders")} onClick={save}>
            {translate(saved ? "settings.ai.saved" : "settings.ai.saveProviders")}
          </SettingsButton>
        } />
        {error ? <p role="alert" className="my-2 text-sm text-(--text-secondary)">{error}</p> : null}
      </fieldset>
    </SettingsSection>
  );
}
