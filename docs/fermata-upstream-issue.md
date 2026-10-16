# Upstream bug report, ready to file against Fermata

This is a draft for
[AndreyPavlenko/Fermata](https://github.com/AndreyPavlenko/Fermata/issues).
It is kept here rather than filed automatically because it is a report to
another project's maintainer and should go out under a real account.

Verified against commit `7d2bd42`. Check that it still applies before
filing — if `onShowFileChooser` has appeared since, this is stale.

---

**Title:** Web browser addon: `<input type="file">` opens the soft keyboard
instead of a file chooser (`onShowFileChooser` not implemented)

---

### What happens

In the built-in web browser, tapping any file-upload control on a web page
raises the Android soft keyboard. No file chooser appears, and there is no
way to pick a file. Tapping again repeats it.

### Steps to reproduce

1. Open the web browser addon.
2. Navigate to any page with a file input (for example
   <https://supermaudio.com>, which asks for an audio file, or any
   minimal test page containing `<input type="file">`).
3. Tap the upload button.

**Expected:** a file chooser opens, and the chosen file is handed to the
page.

**Actual:** the soft keyboard opens. Nothing is selectable.

### Cause

A `WebView` does not implement a file chooser itself. When a page clicks an
`<input type="file">` it calls `WebChromeClient.onShowFileChooser()` and
the host app is expected to launch a picker and return the URIs.

`modules/web/src/main/java/me/aap/fermata/addon/web/FermataChromeClient.java`
extends `WebChromeClient` and overrides `onJsAlert`, `onJsConfirm`,
`onJsPrompt`, `onJsBeforeUnload`, `onShowCustomView`, `onHideCustomView`,
`onGeolocationPermissionsShowPrompt`, `onPermissionRequest` and
`onConsoleMessage` — but not `onShowFileChooser`. The strings
`FileChooserParams` and `ValueCallback<Uri[]>` do not appear anywhere in
the repository.

With the callback unimplemented the click is a no-op, and the input is left
as the focused element — which is why Android raises the IME for it. The
keyboard is a side effect of the click going nowhere, not a separate bug.

### Why pages cannot work around it

Every other route to a local file is also closed in a WebView:
`webkitdirectory` is still an `<input type="file">`;
`showOpenFilePicker()` (File System Access) is not implemented in Android
WebView; an http(s) page cannot read `file://`; there is no drag gesture on
a touch screen; and Web Share Target needs an installed PWA handled by
Chrome. There is also no way for a page to detect the situation in advance
— `.click()` resolves without throwing and no event fires on failure — so
a page cannot even show a useful error. It can only notice afterwards that
nothing happened.

So any page that needs a file from the device is simply unusable in this
browser, with a misleading symptom.

### Suggested fix

Override `onShowFileChooser` in `FermataChromeClient` — launch
`ACTION_GET_CONTENT` (or the photo picker, or `ACTION_OPEN_DOCUMENT`) with
the MIME types the page asked for, and pass the result back through the
callback.

```java
private ValueCallback<Uri[]> filePathCallback;

@Override
public boolean onShowFileChooser(WebView webView,
                                 ValueCallback<Uri[]> callback,
                                 FileChooserParams params) {
    // A pending callback must be released or the page waits forever.
    if (filePathCallback != null) {
        filePathCallback.onReceiveValue(null);
    }
    filePathCallback = callback;
    try {
        // createIntent() already honours the page's accept= and multiple
        // attributes, so this needs no MIME handling of its own.
        startActivityForResult(params.createIntent(), REQUEST_FILE_CHOOSER);
        return true;
    } catch (ActivityNotFoundException e) {
        filePathCallback = null;
        return false; // no picker on this device: let the WebView give up
    }
}

// In the hosting fragment/activity's onActivityResult:
if (requestCode == REQUEST_FILE_CHOOSER) {
    if (filePathCallback != null) {
        filePathCallback.onReceiveValue(
            FileChooserParams.parseResult(resultCode, data));
        filePathCallback = null;
    }
}
```

Two things are worth getting right, because both produce hangs rather than
visible errors:

- **Always call the callback exactly once.** If the chooser is cancelled or
  the activity is destroyed, `onReceiveValue(null)` must still run;
  otherwise the page's input stays stuck and never fires `change` or
  `cancel`.
- **Returning `false`** tells the WebView no chooser is coming, which is
  better than returning `true` and never answering.

`FileChooserParams.parseResult()` and `params.createIntent()` handle the
`accept=` and `multiple` attributes, so no MIME parsing is needed.

### Environment

- Fermata: (fill in your version)
- Android: (fill in)
- Device: (fill in)
- Source inspected at commit `7d2bd42`

### Workaround for anyone who lands here

Until this is implemented, a page has to offer a non-file route. For
supermaudio.com that is a "Load from a URL" field: run a small CORS-enabled
HTTP server on the same device (Termux works) and load
`http://127.0.0.1:<port>/`. Loopback is exempt from mixed-content blocking,
so it is readable even from an https page; a LAN address is not. Opening
the page in Chrome, which does implement a chooser, also works where Chrome
is available.
