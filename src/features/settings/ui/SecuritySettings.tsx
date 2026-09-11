import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  clearUserTrustedDomains,
  getUserTrustedDomains,
  untrustDomain,
} from "@/shared/lib/trustedDomains";

// Security holds the trusted link domains -- previously buried in
// General/Storage.
export function SecuritySettings() {
  const { t } = useTranslation("settings");
  const [trustedDomainsDialogOpen, setTrustedDomainsDialogOpen] =
    useState(false);
  const [trustedDomains, setTrustedDomains] = useState<string[]>(() =>
    getUserTrustedDomains(),
  );

  const refreshTrustedDomains = useCallback(() => {
    setTrustedDomains(getUserTrustedDomains());
  }, []);

  function handleRemoveTrustedDomain(domain: string) {
    untrustDomain(domain);
    refreshTrustedDomains();
    toast.success(t("storage.trustedDomains.removeSuccess", { domain }));
  }

  function handleClearTrustedDomains() {
    clearUserTrustedDomains();
    refreshTrustedDomains();
    toast.success(t("storage.trustedDomains.clearSuccess"));
  }

  const trustedDomainsCount = t("storage.trustedDomains.count", {
    count: trustedDomains.length,
  });

  return (
    <SettingsPage
      title={t("security.title")}
      description={t("security.description")}
      contentClassName="space-y-8"
    >
      <SettingsSections>
        <SettingsSection>
          <SettingsRow
            label={t("storage.trustedDomains.label")}
            description={t("storage.trustedDomains.description")}
          >
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {trustedDomainsCount}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setTrustedDomainsDialogOpen(true)}
              >
                {t("storage.trustedDomains.manage")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsSection>
      </SettingsSections>

      <Dialog
        open={trustedDomainsDialogOpen}
        onOpenChange={setTrustedDomainsDialogOpen}
      >
        <DialogContent className="max-w-md gap-5">
          <DialogHeader>
            <DialogTitle>{t("storage.trustedDomains.label")}</DialogTitle>
            <DialogDescription>
              {t("storage.trustedDomains.description")}
            </DialogDescription>
          </DialogHeader>

          {trustedDomains.length > 0 ? (
            <ul
              className="max-h-80 space-y-2 overflow-y-auto pr-1"
              aria-label={t("storage.trustedDomains.listLabel")}
            >
              {trustedDomains.map((domain) => (
                <li
                  key={domain}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm" title={domain}>
                    {domain}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => handleRemoveTrustedDomain(domain)}
                    aria-label={t("storage.trustedDomains.removeAria", {
                      domain,
                    })}
                  >
                    <Trash2 className="size-3.5" />
                    {t("storage.trustedDomains.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-md bg-muted px-3 py-3 text-sm text-muted-foreground">
              {t("storage.trustedDomains.empty")}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClearTrustedDomains}
              disabled={trustedDomains.length === 0}
            >
              <Trash2 className="size-3.5" />
              {t("storage.trustedDomains.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  );
}
