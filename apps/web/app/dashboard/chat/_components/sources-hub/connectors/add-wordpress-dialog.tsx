import { useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { HttpClientError } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Label } from "@sourceweft/ui-web/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@sourceweft/ui-web/components/ui/radio-group";

import { getErrorMessage } from "../lib/errors";
import type { SiteAddInput, SiteCheckInput, SiteCheckResult } from "./types";
import type { WordpressAccess } from "./types";
import {
  isAcceptableSiteUrl,
  WORDPRESS_SITE_URL_MAX_LENGTH,
} from "./wordpress-site-url";

const DEFAULT_NAME = "WordPress";
const USERNAME_MAX_LENGTH = 200;
const SECRET_MAX_LENGTH = 2000;

/** Readiness reasons that have their own copy (`READINESS_REASONS` in
 * packages/builtin-connector-wordpress/src/adapter-error.ts). Anything else
 * falls back to the generic not-ready copy. */
const WORDPRESS_FAILURE_REASONS = [
  "config_invalid",
  "unreachable",
  "not_a_wordpress_site",
  "rest_disabled",
  "login_required",
  "reauth_required",
  "insufficient_permission",
  "blocked_endpoint",
  "rate_limited",
] as const;

/** A username the server would accept: 1..200 after trimming, no colon (the
 * Basic-auth separator). */
function isAcceptableUsername(value: string) {
  return (
    value.length > 0 &&
    value.length <= USERNAME_MAX_LENGTH &&
    !value.includes(":")
  );
}

function hostOf(siteUrl: string) {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

type Checked = {
  siteUrl: string;
  access: WordpressAccess;
  username: string;
  secret: string;
  includeUnpublished: boolean;
  result: SiteCheckResult;
};

function AddWordpressForm({
  onAdd,
  onCheck,
  onOpenChange,
}: Pick<Parameters<typeof AddWordpressDialog>[0], "onAdd" | "onCheck"> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [siteUrl, setSiteUrl] = useState("");
  const [access, setAccess] = useState<WordpressAccess>("public");
  const [username, setUsername] = useState("");
  // The Application Password is held only here, in local component state, and is
  // cleared after any submit or failure (below). It is never lifted into a query
  // cache, the URL or storage, and never rendered.
  const [secret, setSecret] = useState("");
  // Opt-in: drafts and private posts become visible to every workspace member.
  const [includeUnpublished, setIncludeUnpublished] = useState(false);
  const [name, setName] = useState(DEFAULT_NAME);
  // Scheduled reconciliation is opt-in: the connector only keeps syncing on a
  // schedule when the member asks.
  const [autoSync, setAutoSync] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  // Set synchronously on the first Add so a second click or submit in the same
  // tick cannot send another create before the disabled state renders.
  const addingRef = useRef(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [urlRejected, setUrlRejected] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Only the latest check may settle: an input edit or a newer check bumps it.
  const checkSeq = useRef(0);

  const trimmedUrl = siteUrl.trim();
  const trimmedUsername = username.trim();
  const isLogin = access === "login";
  // A check only counts for the exact inputs it ran with. The credential fields
  // and the drafts flag matter only for the login choice.
  const result =
    checked &&
    checked.siteUrl === trimmedUrl &&
    checked.access === access &&
    (!isLogin ||
      (checked.username === trimmedUsername &&
        checked.secret === secret &&
        checked.includeUnpublished === includeUnpublished))
      ? checked.result
      : null;
  const urlInvalid = trimmedUrl !== "" && !isAcceptableSiteUrl(trimmedUrl);
  const hasCheckInputs =
    trimmedUrl !== "" &&
    (!isLogin || (trimmedUsername !== "" && secret !== ""));
  const canAdd = result?.ready === true && !isChecking && !isAdding;

  function invalidateCheck() {
    checkSeq.current += 1;
    setIsChecking(false);
    setUrlRejected(false);
    setFieldError(null);
    setCheckError(false);
    setAddError(null);
  }

  // The selection (content types, categories, posts, pages) is chosen after the
  // connector exists, so the check and the create both carry an empty selection.
  function buildInput(): SiteCheckInput {
    return isLogin
      ? {
          access: "login",
          siteUrl: trimmedUrl,
          includeUnpublished,
          credential: { username: trimmedUsername, secret },
        }
      : { access: "public", siteUrl: trimmedUrl, includeUnpublished };
  }

  async function handleCheck() {
    setAddError(null);
    setCheckError(false);
    if (!isAcceptableSiteUrl(trimmedUrl)) {
      setUrlRejected(true);
      return;
    }
    setUrlRejected(false);
    if (isLogin) {
      if (!isAcceptableUsername(trimmedUsername)) {
        setFieldError(t("connectors.wordpress.dialog.invalidUsername"));
        return;
      }
      if (secret.length === 0 || secret.length > SECRET_MAX_LENGTH) {
        setFieldError(t("connectors.wordpress.dialog.passwordRequired"));
        return;
      }
    }
    setFieldError(null);
    const seq = (checkSeq.current += 1);
    const checkedSecret = secret;
    setIsChecking(true);
    try {
      const next = await onCheck(buildInput());
      if (seq !== checkSeq.current) return;
      setChecked({
        siteUrl: trimmedUrl,
        access,
        username: trimmedUsername,
        secret: checkedSecret,
        includeUnpublished,
        result: next,
      });
    } catch {
      if (seq !== checkSeq.current) return;
      setChecked(null);
      setCheckError(true);
    } finally {
      if (seq === checkSeq.current) setIsChecking(false);
    }
  }

  async function handleAdd() {
    if (!result?.ready || addingRef.current) return;
    addingRef.current = true;
    setAddError(null);
    setIsAdding(true);
    try {
      const input: SiteAddInput = {
        ...buildInput(),
        name: name.trim() || DEFAULT_NAME,
        periodicIndexingEnabled: autoSync,
      };
      await onAdd(input);
      // The create succeeded; the dialog is closing, but drop the secret and the
      // checked result from state immediately so neither lingers after the submit.
      setSecret("");
      setChecked(null);
      onOpenChange(false);
    } catch (error) {
      // The create failed with the secret already in flight: clear it so a retry
      // re-enters it deliberately and nothing is retained after a failure.
      setSecret("");
      setChecked(null);
      setAddError(addFailureText(error));
    } finally {
      addingRef.current = false;
      setIsAdding(false);
    }
  }

  function addFailureText(error: unknown): string {
    if (error instanceof HttpClientError) {
      if (error.code === "CONNECTOR_CREDENTIAL_NOT_ALLOWED") {
        return t("connectors.wordpress.dialog.credentialNotAllowed");
      }
      if (error.code === "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS") {
        return t("connectors.wordpress.dialog.accountConflict");
      }
      if (error.code === "CONNECTOR_ALREADY_EXISTS") {
        return t("connectors.wordpress.dialog.nameConflict");
      }
    }
    return getErrorMessage(error, t("connectors.wordpress.dialog.addFailed"));
  }

  function failureText(reason: string) {
    if ((WORDPRESS_FAILURE_REASONS as readonly string[]).includes(reason)) {
      return t(`connectors.wordpress.readiness.${reason}`);
    }
    return t("connectors.readinessNotReady");
  }

  const errorText = urlRejected
    ? t("connectors.wordpress.dialog.invalidUrl")
    : fieldError
      ? fieldError
      : checkError
        ? t("connectors.wordpress.dialog.checkFailed")
        : result && !result.ready
          ? failureText(result.reason)
          : addError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.wordpress.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.wordpress.dialog.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAdd) void handleAdd();
          else if (!isChecking && hasCheckInputs) void handleCheck();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="add-wordpress-url">
            {t("connectors.wordpress.siteUrlLabel")}
          </Label>
          <Input
            aria-describedby="add-wordpress-url-hint"
            aria-invalid={urlInvalid}
            autoComplete="off"
            id="add-wordpress-url"
            inputMode="url"
            maxLength={WORDPRESS_SITE_URL_MAX_LENGTH + 64}
            name="wordpressSiteUrl"
            onChange={(event) => {
              setSiteUrl(event.target.value);
              invalidateCheck();
            }}
            placeholder="https://blog.example.com"
            type="url"
            value={siteUrl}
          />
          <p
            className="text-xs text-muted-foreground"
            id="add-wordpress-url-hint"
          >
            {t("connectors.wordpress.siteUrlHint")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("connectors.wordpress.wordpressComNote")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label id="add-wordpress-access-label">
            {t("connectors.wordpress.accessLabel")}
          </Label>
          <RadioGroup
            aria-labelledby="add-wordpress-access-label"
            className="grid gap-2"
            onValueChange={(value) => {
              setAccess(value === "login" ? "login" : "public");
              invalidateCheck();
            }}
            value={access}
          >
            {(["public", "login"] as const).map((option) => (
              <label
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-xs has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/40"
                htmlFor={`add-wordpress-access-${option}`}
                key={option}
              >
                <RadioGroupItem
                  className="mt-0.5"
                  id={`add-wordpress-access-${option}`}
                  value={option}
                />
                <span className="space-y-0.5">
                  <span className="block font-medium text-foreground">
                    {option === "public"
                      ? t("connectors.wordpress.accessPublic")
                      : t("connectors.wordpress.accessLogin")}
                  </span>
                  <span className="block text-muted-foreground">
                    {option === "public"
                      ? t("connectors.wordpress.accessPublicHint")
                      : t("connectors.wordpress.accessLoginHint")}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>

        {isLogin ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="add-wordpress-username">
                  {t("connectors.wordpress.usernameLabel")}
                </Label>
                <Input
                  autoComplete="off"
                  id="add-wordpress-username"
                  maxLength={USERNAME_MAX_LENGTH}
                  name="wordpressUsername"
                  onChange={(event) => {
                    setUsername(event.target.value);
                    invalidateCheck();
                  }}
                  value={username}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-wordpress-password">
                  {t("connectors.wordpress.passwordLabel")}
                </Label>
                <Input
                  autoComplete="new-password"
                  id="add-wordpress-password"
                  maxLength={SECRET_MAX_LENGTH}
                  name="wordpressPassword"
                  onChange={(event) => {
                    setSecret(event.target.value);
                    invalidateCheck();
                  }}
                  type="password"
                  value={secret}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("connectors.wordpress.appPasswordHint")}
            </p>

            <div className="flex items-start gap-2">
              <Checkbox
                checked={includeUnpublished}
                className="mt-0.5"
                id="add-wordpress-unpublished"
                onCheckedChange={(value) => {
                  setIncludeUnpublished(value === true);
                  invalidateCheck();
                }}
              />
              <div className="space-y-0.5">
                <Label
                  className="font-normal"
                  htmlFor="add-wordpress-unpublished"
                >
                  {t("connectors.wordpress.includeUnpublishedLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.wordpress.includeUnpublishedWarning")}
                </p>
              </div>
            </div>
          </>
        ) : null}

        <div>
          <Button
            disabled={isChecking || isAdding || !hasCheckInputs}
            onClick={() => void handleCheck()}
            type="button"
            variant="outline"
          >
            {isChecking ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.wordpress.dialog.checking")}
              </>
            ) : (
              t("connectors.wordpress.dialog.check")
            )}
          </Button>
        </div>

        {result?.ready ? (
          <>
            <div className="flex items-start gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {t("connectors.wordpress.dialog.reachable")}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {hostOf(trimmedUrl)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.wordpress.dialog.reachableHint")}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="add-wordpress-name">
                {t("connectors.wordpress.nameLabel")}
              </Label>
              <Input
                autoComplete="off"
                id="add-wordpress-name"
                maxLength={200}
                name="wordpressName"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                checked={autoSync}
                className="mt-0.5"
                id="add-wordpress-autosync"
                onCheckedChange={(value) => setAutoSync(value === true)}
              />
              <div className="space-y-0.5">
                <Label className="font-normal" htmlFor="add-wordpress-autosync">
                  {t("connectors.wordpress.dialog.autoSync")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.wordpress.dialog.autoSyncHint")}
                </p>
              </div>
            </div>
          </>
        ) : null}

        {errorText ? (
          <Alert variant="destructive">
            <AlertDescription>{errorText}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("common.cancel")}
          </Button>
          <Button disabled={!canAdd} type="submit">
            {isAdding ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.wordpress.dialog.add")}
              </>
            ) : (
              t("connectors.wordpress.dialog.add")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Presentational add dialog for a WordPress site (`site_url` add mode): the site
 * address and an access choice (a public site, created as `wordpress`, or an
 * Application Password login, created as `wordpress_login`), then a "Check site"
 * readiness check, then the name and schedule and create. The access choice
 * decides which connector type the parent creates. The login choice adds a
 * username and Application Password and an opt-in "include drafts and private
 * posts" box; the Application Password lives only in this component's local
 * state and is cleared on submit, on failure and whenever the dialog is reopened
 * (a fresh form mounts per open). It is never rendered, logged or placed in a
 * cache, the URL or storage. The selection (content types, categories, posts,
 * pages) is chosen after the connector exists, through the shared picker.
 */
export function AddWordpressDialog({
  open,
  onOpenChange,
  onCheck,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheck: (input: SiteCheckInput) => Promise<SiteCheckResult>;
  onAdd: (input: SiteAddInput) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        {/* Rendered inside the content so each open starts with a fresh form,
            and the Application Password state is dropped when the dialog closes. */}
        <AddWordpressForm
          onAdd={onAdd}
          onCheck={onCheck}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
