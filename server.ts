import express from 'express';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());
app.use('/games', express.static('games'));
app.use('/virtual-run', express.static('virtual-run'));

// YouTube oEmbed Proxy to fetch title & metadata cleanly without CORS issues
app.get('/api/oembed', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'videoId is required' });
  }

  try {
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(ytUrl)}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) {
      return res.status(404).json({ error: 'Vidéo introuvable ou intégration désactivée' });
    }
    const data = await response.json();
    return res.json({
      title: data.title,
      author: data.author_name,
      thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// AI Agent tools definitions
const AI_TOOLS: FunctionDeclaration[] = [
  {
    name: 'set_title',
    description: 'Renames the video project or modifies its interactive title.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'The new title for the video project' },
      },
      required: ['title'],
    },
  },
  {
    name: 'set_trim',
    description: 'Sets the video in (start) and out (end) trim boundaries in seconds.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        start: { type: Type.NUMBER, description: 'Trim start in seconds' },
        end: { type: Type.NUMBER, description: 'Trim end in seconds' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'add_cut',
    description: 'Removes or skips a segment of the video non-destructively during playback.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        start: { type: Type.NUMBER, description: 'Cut start in seconds' },
        end: { type: Type.NUMBER, description: 'Cut end in seconds' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'set_audio_muted',
    description: 'Mutes or unmutes the video audio.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        muted: { type: Type.BOOLEAN, description: 'True to mute audio, false to unmute' },
      },
      required: ['muted'],
    },
  },
  {
    name: 'add_event',
    description: 'Adds an obstacle or interactive action event at a specific timestamp.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        time: { type: Type.NUMBER, description: 'Time in seconds (original video time)' },
        action: {
          type: Type.STRING,
          description: 'Type of required action',
          enum: [
            'STARTING COUNT',
            'GO',
            'JUMP',
            'RIGHT',
            'LEFT',
            'SLIDE DOWN',
            'SLASH',
            'PUNCH',
            'END',
            'WIN',
          ],
        },
        showOnScreen: {
          type: Type.BOOLEAN,
          description: 'Whether to show the visual cue on screen (true) or keep it hidden (false)',
        },
        hint: { type: Type.STRING, description: 'Visual hint text for the user' },
      },
      required: ['time', 'action'],
    },
  },
  {
    name: 'generate_script_from_video',
    description: 'Automatically generates a complete balanced game script or virtual run course.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mode: { type: Type.STRING, enum: ['game', 'virtual_run'] },
        difficulty: { type: Type.STRING, enum: ['easy', 'normal', 'hard'] },
        title: { type: Type.STRING, description: 'Suggested project title' },
      },
      required: ['mode'],
    },
  },
];

// Fallback rule-based action generator if external AI API is temporarily unavailable
function fallbackAgentResponse(prompt: string, projectState: any) {
  const lower = prompt.toLowerCase();
  const functionCalls: any[] = [];
  let text = '';

  if (lower.includes('titre') || lower.includes('nom') || lower.includes('renomme')) {
    const match = prompt.match(/["']([^"']+)["']/) || prompt.match(/(?:titre|nomme|nommé|renomme[r]?)\s+(?:en|comme|:)?\s*([a-zA-Z0-9À-ÿ\s\-_]+)/i);
    const suggested = match ? match[1].trim() : (projectState?.name ? `${projectState.name} (Édité)` : 'Mon Aventure Interactive');
    functionCalls.push({ name: 'set_title', args: { title: suggested } });
    text = `J'ai renommé votre projet en "${suggested}".`;
  } else if (lower.includes('jeu') || lower.includes('game') || lower.includes('obstacle') || lower.includes('scénario') || lower.includes('scenario')) {
    functionCalls.push({ name: 'generate_script_from_video', args: { mode: 'game', difficulty: 'normal', title: `${projectState?.name || 'Vidéo'} - Course Action` } });
    text = `J'ai créé un scénario de jeu d'action complet avec les actions requises (STARTING COUNT, GO, JUMP, RIGHT, LEFT, SLIDE DOWN, SLASH, PUNCH, END, WIN) !`;
  } else if (lower.includes('saut') || lower.includes('jump')) {
    const tStart = projectState?.trimStart || 2;
    functionCalls.push({ name: 'add_event', args: { time: Number((tStart + 3.5).toFixed(2)), action: 'JUMP', showOnScreen: true, hint: 'Sautez !' } });
    text = `J'ai placé l'action 'JUMP' synchronisée sur la timeline avec affichage à l'écran activé.`;
  } else if (lower.includes('slash') || lower.includes('épée') || lower.includes('tranche')) {
    const tStart = projectState?.trimStart || 2;
    functionCalls.push({ name: 'add_event', args: { time: Number((tStart + 5.0).toFixed(2)), action: 'SLASH', showOnScreen: true, hint: 'Coup d\'épée !' } });
    text = `J'ai ajouté l'action 'SLASH' sur la timeline.`;
  } else if (lower.includes('punch') || lower.includes('poing') || lower.includes('frappe')) {
    const tStart = projectState?.trimStart || 2;
    functionCalls.push({ name: 'add_event', args: { time: Number((tStart + 6.5).toFixed(2)), action: 'PUNCH', showOnScreen: true, hint: 'Frappe directe !' } });
    text = `J'ai ajouté l'action 'PUNCH' sur la timeline.`;
  } else if (lower.includes('slide') || lower.includes('glisse')) {
    const tStart = projectState?.trimStart || 2;
    functionCalls.push({ name: 'add_event', args: { time: Number((tStart + 4.0).toFixed(2)), action: 'SLIDE DOWN', showOnScreen: true, hint: 'Glissez !' } });
    text = `J'ai ajouté l'action 'SLIDE DOWN' sur la timeline.`;
  } else if (lower.includes('run') || lower.includes('course') || lower.includes('tapis') || lower.includes('treadmill')) {
    functionCalls.push({ name: 'generate_script_from_video', args: { mode: 'virtual_run', difficulty: 'normal', title: `${projectState?.name || 'Parcours'} - Trail Virtuel` } });
    text = `J'ai configuré votre vidéo en parcours Virtual Run avec des segments de pente adaptés et des paliers de vitesse.`;
  } else if (lower.includes('muet') || lower.includes('coupe le son') || lower.includes('mute')) {
    functionCalls.push({ name: 'set_audio_muted', args: { muted: true } });
    text = `J'ai coupé l'audio de la vidéo.`;
  } else {
    text = `Je suis prêt à vous aider. Vous pouvez me demander de générer des actions (STARTING COUNT, GO, JUMP, RIGHT, LEFT, SLIDE DOWN, SLASH, PUNCH, END, WIN) ou de configurer le projet.`;
  }

  return { text, functionCalls };
}

app.post('/api/gemini/chat', async (req, res) => {
  const { prompt, projectState, apiKey: userProvidedKey } = req.body;
  const keyToUse = userProvidedKey || process.env.GEMINI_API_KEY;

  if (keyToUse) {
    try {
      const ai = new GoogleGenAI({
        apiKey: keyToUse,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = `Tu es l'assistant de VideoPlay Studio, un studio de montage vidéo interactif pour YouTube.
Tu aides l'utilisateur à créer des jeux d'action (Game) et des parcours de course virtuelle (Virtual Run) à partir de vidéos YouTube.
RÈGLES IMPORTANTES :
- Toutes les actions et coupes sont non-destructives.
- Les timestamps sont TOUJOURS en secondes réelles de la vidéo originale.
- Si l'utilisateur demande de changer le titre ou le nom de la vidéo, appelle l'outil 'set_title'.
- Si l'utilisateur demande des obstacles ou un scénario, appelle 'add_event' ou 'generate_script_from_video'.
- Réponds en français de manière directe et concise.`;

      const contents = [
        {
          role: 'user' as const,
          parts: [
            {
              text: `${systemInstruction}\n\nÉtat actuel du projet vidéo:\n${JSON.stringify(projectState, null, 2)}\n\nDemande de l'utilisateur: "${prompt}"`,
            },
          ],
        },
      ];

      // Try available models in order with a 4.5s timeout per attempt
      const candidateModels = ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
      for (const modelName of candidateModels) {
        try {
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('API Timeout')), 4500));
          const response: any = await Promise.race([
            ai.models.generateContent({
              model: modelName,
              contents,
              config: {
                tools: [{ functionDeclarations: AI_TOOLS }],
              },
            }),
            timeoutPromise,
          ]);

          const functionCalls = response.functionCalls || [];
          const text = response.text || '';
          return res.json({ text, functionCalls });
        } catch (mErr: any) {
          console.warn(`Model ${modelName} failed or timed out:`, mErr.message);
        }
      }
    } catch (error: any) {
      console.warn('Gemini API call failed, falling back to built-in generator:', error.message);
    }
  }

  // Fallback to intelligent local dispatcher if remote call failed or timed out
  const fallback = fallbackAgentResponse(prompt, projectState);
  return res.json(fallback);
});

// Vite middleware mounting
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VideoPlay Studio running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
