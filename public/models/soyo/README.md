Place a Live2D model that you are licensed to use here. The runtime supports both
Cubism 2 and Cubism 4 and loads only the matching Core at runtime.

Supported entry files:

```text
model.json          # Cubism 2
model.model3.json   # Cubism 4
```

Point `LIVE2D_MODEL_PATH` (or the Character console) at the selected JSON file,
then validate the package before deployment:

```bash
npm run live2d:inspect -- public/models/soyo/<package>/<entry>.json --strict
```

Do not commit or redistribute third-party model assets without permission.
