import * as Dialog from "@radix-ui/react-dialog";
import { RotateCcw, Settings, X } from "lucide-react";
import { SelectControl } from "./ui";
import { AppearanceChoices, type Appearance } from "./useAppearance";
import { readChoice } from "./model";
import { LogFonts, LogLineHeights, UiFonts, type TypographySettings } from "./useTypography";

export function SettingsDialog({ open, settings, saved, appearance, onAppearance, onChange, onReset, onClose, returnFocus }: {
  open: boolean;
  settings: TypographySettings;
  saved: boolean;
  appearance: Appearance;
  onAppearance(value: Appearance): void;
  onChange(changes: Partial<TypographySettings>): void;
  onReset(): void;
  onClose(): void;
  returnFocus(): void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
          <div className="dialog-titlebar">
            <div className="dialog-icon"><Settings size={20} /></div>
            <div>
              <Dialog.Title>Settings</Dialog.Title>
              <Dialog.Description>Customize the interface and log text. Changes apply immediately.</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close settings"><X size={18} /></Dialog.Close>
          </div>
          <div className="settings-content">
            <label className="settings-row" htmlFor="settingsAppearance"><span>Appearance</span>
              <SelectControl id="settingsAppearance" label="Appearance mode" value={appearance}
                choices={[{ value: "system", label: "System preference" }, { value: "light", label: "Light Mode" }, { value: "dark", label: "Dark Mode" }]}
                onChange={value => onAppearance(readChoice(value, AppearanceChoices))} />
            </label>
            <fieldset className="settings-group">
              <legend>Interface</legend>
              <label className="settings-row" htmlFor="uiFont"><span>UI font</span>
                <SelectControl id="uiFont" label="UI font" value={settings.uiFont} choices={UiFonts}
                  onChange={value => onChange({ uiFont: readChoice(value, UiFonts.map(font => font.value)) })} />
              </label>
              <label className="settings-row" htmlFor="uiFontSize"><span>UI font size</span>
                <SelectControl id="uiFontSize" label="UI font size" value={String(settings.uiFontSize)}
                  choices={Array.from({ length: 7 }, (_, index) => ({ value: String(index + 12), label: `${index + 12} px` }))}
                  onChange={value => onChange({ uiFontSize: Number(value) })} />
              </label>
              <p className="settings-ui-preview">Preview: Search, filter, and inspect your logs.</p>
            </fieldset>
            <fieldset className="settings-group">
              <legend>Log text</legend>
              <label className="settings-row" htmlFor="logFont"><span>Log font</span>
                <SelectControl id="logFont" label="Log font" value={settings.logFont} choices={LogFonts}
                  onChange={value => onChange({ logFont: readChoice(value, LogFonts.map(font => font.value)) })} />
              </label>
              <label className="settings-row" htmlFor="logFontSize"><span>Log font size</span>
                <SelectControl id="logFontSize" label="Log font size" value={String(settings.logFontSize)}
                  choices={Array.from({ length: 15 }, (_, index) => ({ value: String(index + 10), label: `${index + 10} px` }))}
                  onChange={value => onChange({ logFontSize: Number(value) })} />
              </label>
              <label className="settings-row" htmlFor="logLineHeight"><span>Log line spacing</span>
                <SelectControl id="logLineHeight" label="Log line spacing" value={String(settings.logLineHeight)}
                  choices={LogLineHeights.map((height, index) => ({ value: String(height), label: ["Compact", "Comfortable", "Spacious"][index]! }))}
                  onChange={value => onChange({ logLineHeight: Number(value) as TypographySettings["logLineHeight"] })} />
              </label>
              <pre className="settings-log-preview" aria-label="Log font preview">{"12:34:56  INFO  Application started\n12:34:57  WARN  Retrying request…"}</pre>
            </fieldset>
            <p className="muted">Fonts use local fallbacks; nothing is downloaded. Typography is saved for this browser and server address (including its port).</p>
            {!saved && <p className="notice warning" role="status">Browser storage is unavailable. Typography changes work in this tab but may not survive a reload.</p>}
            <div className="dialog-footer">
              <button onClick={onReset}><RotateCcw size={14} /> Reset typography</button>
              <Dialog.Close className="primary">Done</Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
