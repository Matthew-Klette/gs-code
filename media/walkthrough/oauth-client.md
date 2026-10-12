# Create your own OAuth client (one time, about 10 minutes)

GS Code signs in with **your** Google account through **your own** OAuth client. There is no GS Code server and no shared app, so nobody else ever sees your tokens. It costs nothing: the Tag Manager API needs no billing account.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (any name), or use one you already have.
2. **APIs & Services → Library** → enable **Tag Manager API**.
3. **Google Auth Platform → Branding / Audience**: any app name; audience **Internal** on Google Workspace, otherwise **External** and add your Google account under **Test users**.
4. **Google Auth Platform → Clients → Create client** → type **Desktop app** → **Download JSON**.

Tip: with an External app in **Testing**, Google expires the sign-in every 7 days. Set the publishing status to **In production** to avoid that (the "unverified app" screen stays, because the app is yours).
