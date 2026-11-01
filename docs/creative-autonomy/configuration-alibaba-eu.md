# Alibaba Model Studio account: Frankfurt, EU scope (no secret in this file)

1. **Account.** Create (or reuse) an account on the international site, alibabacloud.com, and add the payment method it asks for. The Frankfurt region has no free quota: everything is pay-as-you-go.
2. **Console.** Open Model Studio in the Germany (Frankfurt) region: `https://modelstudio.console.alibabacloud.com/eu-central-1`. Activate the service if asked.
3. **EU workspace.** Go to "Workspace Management" (Frankfurt) and create a workspace named `nordla-essai-eu`. Choose the **EU** service deployment scope, not Global. The scope is fixed at creation.
4. **Model.** Check that `qwen3-vl-plus` appears in the list of models available to this workspace.
5. **Workspace ID.** Copy it from the console. It is an identifier, not a password, but it is kept with the key.
6. **API key.** Go to "Key Management" (Frankfurt) and create a key **for this workspace only**. Copy it once, straight to where it will be stored (step 8). Never paste it into a chat, an email, a document or GitHub.
7. **Spending alert.** If the billing console offers a spending alert, set a low threshold (for example 5 €). This is in addition to Nordla's 1.50 € ceiling.
8. **Storing the key, two options.**
   - A: environment variables or secrets added to the environment that runs the trial: `ALIBABA_MODEL_STUDIO_API_KEY`, `ALIBABA_MODEL_STUDIO_WORKSPACE_ID`.
   - B: a text file on the machine that runs the trial, outside any project folder, readable by you only (`chmod 600`), containing:
     ```
     ALIBABA_MODEL_STUDIO_API_KEY=<the key>
     ALIBABA_MODEL_STUDIO_WORKSPACE_ID=<the id>
     ```
     Its path is given through `NORDLA_ALIBABA_SECRETS_FILE`. The script refuses the file if it is inside a git repository or readable by others, and it never prints the key.
9. **Check without spending.** `--plan` shows "clé API : présente (non affichée)". Nothing is sent.
10. **After the trial.** Read the invoice in the billing console, then revoke the key if it is not reused.
