export interface GooglePromptNotification {
  isNotDisplayed?: () => boolean;
  isSkippedMoment?: () => boolean;
  getNotDisplayedReason?: () => string;
  getSkippedReason?: () => string;
}

export interface GoogleAccountsId {
  initialize: (cfg: {
    client_id: string;
    callback: (resp: { credential?: string }) => void;
    ux_mode?: 'popup' | 'redirect';
    use_fedcm_for_prompt?: boolean;
  }) => void;
  prompt: (momentListener?: (notification: GooglePromptNotification) => void) => void;
  renderButton: (
    parent: HTMLElement,
    options: {
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'large' | 'medium' | 'small';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
      width?: number | string;
    },
  ) => void;
}

export function getGoogleAccountsId(): GoogleAccountsId | null {
  const win = window as unknown as {
    google?: { accounts?: { id?: GoogleAccountsId } };
  };
  return win.google?.accounts?.id ?? null;
}

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/**
 * Loads Google Identity Services lazily if the async script in <head> has not
 * finished downloading or was blocked earlier. Never throws uncaught script errors.
 */
export async function loadGoogleIdentityServices(timeoutMs = 8000): Promise<GoogleAccountsId | null> {
  const existing = getGoogleAccountsId();
  if (existing) return existing;

  return new Promise<GoogleAccountsId | null>((resolve) => {
    let settled = false;
    const finish = (api: GoogleAccountsId | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(api);
    };

    const timer = window.setTimeout(() => {
      finish(getGoogleAccountsId());
    }, timeoutMs);

    let script = document.querySelector<HTMLScriptElement>(
      `script[src^="${GIS_SCRIPT_SRC}"]`,
    );

    if (script && script.dataset.gisFailed === 'true') {
      script.remove();
      script = null;
    }

    if (!script) {
      script = document.createElement('script');
      script.src = GIS_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    const checkNow = () => {
      const api = getGoogleAccountsId();
      if (api) {
        finish(api);
        return true;
      }
      return false;
    };

    if (checkNow()) return;

    const onLoad = () => {
      if (!checkNow()) {
        // Give GIS a microtask to initialize window.google.accounts.id
        window.setTimeout(() => finish(getGoogleAccountsId()), 50);
      }
    };
    const onError = () => {
      if (script) script.dataset.gisFailed = 'true';
      finish(null);
    };

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });

    // Poll briefly in case the existing <script> tag already fired 'load' before listener attached
    const poll = window.setInterval(() => {
      if (settled || checkNow()) {
        window.clearInterval(poll);
      }
    }, 100);
  });
}
