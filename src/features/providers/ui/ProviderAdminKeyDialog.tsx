import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { useProviderAccountsStore } from "../stores/providerAccountsStore";
import type { ProviderAccount } from "../api/providerAccounts";

/** Whether `account` can read its organization's spend with an admin key. */
export function readsApiSpend(account: ProviderAccount): boolean {
  return account.providerId === "codex-acp" && account.authMethod === "api_key";
}

/** Saves the OpenAI Admin key a Codex API-key account reads its spend with. */
export function ProviderAdminKeyDialog({
  account,
  onClose,
}: {
  account: ProviderAccount;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const [adminKey, setAdminKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setAdminKey("");
    onClose();
  };
  const save = async () => {
    if (!adminKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await useProviderAccountsStore
        .getState()
        .setAdminKey(account.id, adminKey.trim());
      close();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("accounts.spendTitle")}</DialogTitle>
          <DialogDescription>
            {t("accounts.spendDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <Label htmlFor="provider-account-admin-key">
            {t("accounts.adminKey")}
          </Label>
          <Input
            id="provider-account-admin-key"
            type="password"
            autoComplete="off"
            autoFocus
            value={adminKey}
            onChange={(event) => setAdminKey(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("accounts.adminKeyHint")}
          </p>
          {error ? (
            <p role="alert" className="break-words text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={close}
          >
            {t("accounts.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !adminKey.trim()}
            onClick={() => void save()}
          >
            {busy ? t("accounts.saving") : t("accounts.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
