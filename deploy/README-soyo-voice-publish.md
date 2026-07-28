# Soyo voice sample publish bundle

This bundle publishes the two prepared Soyo voice-clone samples:

- `voice-samples/soyo-soft.wav`
- `voice-samples/soyo-natural.wav`

Expected public URLs after deployment:

- `http://112.126.56.251/voice-samples/soyo-soft.wav`
- `http://112.126.56.251/voice-samples/soyo-natural.wav`

## Deploy to an existing nginx site

On the server, copy `soyo-static-dist.tar.gz` to a temporary directory and run:

```bash
sudo mkdir -p /var/www/soyo
sudo tar -xzf soyo-static-dist.tar.gz -C /var/www/soyo
sudo ln -sfn /var/www/soyo /var/www/html/soyo
```

If your nginx root is `/var/www/html`, the files are then available under:

```text
http://112.126.56.251/soyo/voice-samples/soyo-soft.wav
http://112.126.56.251/soyo/voice-samples/soyo-natural.wav
```

If you want them at `/voice-samples/...`, copy only the `voice-samples` directory into the current site root:

```bash
sudo tar -xzf soyo-static-dist.tar.gz -C /tmp/soyo-static
sudo cp -R /tmp/soyo-static/voice-samples /var/www/html/
```

Verify the server returns WAV, not HTML:

```bash
curl -I http://112.126.56.251/voice-samples/soyo-soft.wav
curl -I http://112.126.56.251/voice-samples/soyo-natural.wav
```

Then create the two Aliyun voices from the local project:

```bash
npm run voice:clone:soyo -- \
  --soft-url http://112.126.56.251/voice-samples/soyo-soft.wav \
  --natural-url http://112.126.56.251/voice-samples/soyo-natural.wav
```
