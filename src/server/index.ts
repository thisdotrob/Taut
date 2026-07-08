import { createApp } from './routes';

const port = Number(process.env.PORT ?? 8787);
const app = createApp();

app.listen(port, () => {
  console.log(`Taut API listening on http://localhost:${port}`);
});
