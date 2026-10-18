import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';

const DISCORD_API = 'https://discord.com/api/v10';
const BUILD_TARGETS = {
  medusa: { label: 'Medusa', repoVariable: 'MEDUSA_REPO' },
  aurora: { label: 'Aurora Launcher', repoVariable: 'AURORA_REPO' }
};

export function getBuildTarget(env, targetName) {
  const target = BUILD_TARGETS[targetName];
  const repository = target && env[target.repoVariable];
  if (!target || !repository || !env.GITHUB_OWNER || !env.BUILD_WORKFLOW || !env.BUILD_REF) {
    return null;
  }

  return { ...target, name: targetName, repository };
}

export function isConfiguredTicket(env, interaction) {
  return Boolean(
    env.DISCORD_GUILD_ID &&
    env.DISCORD_TICKET_CATEGORY_ID &&
    interaction.guild_id === env.DISCORD_GUILD_ID
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    const url = new URL(request.url);
    if (url.pathname === '/build-callback') {
      return handleBuildCallback(request, env);
    }

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.clone().text();
    const isValidRequest = await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);

    if (!isValidRequest) {
      return new Response('Bad request signature.', { status: 401 });
    }

    const interaction = JSON.parse(body);
    if (interaction.type === InteractionType.PING) {
      return Response.json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      return handleCommand(interaction, env);
    }

    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      return handleComponent(interaction, request, env, ctx);
    }

    return new Response('Unknown Type', { status: 400 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupTickets(env));
  }
};

function ephemeral(content) {
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 }
  });
}

function interactionUserId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id;
}

async function handleBuildCallback(request, env) {
  if (!env.BUILD_CALLBACK_SECRET || request.headers.get('Authorization') !== `Bearer ${env.BUILD_CALLBACK_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { user_id: userId, status, run_url: runUrl } = await request.json();
    if (!userId || !['success', 'failure', 'cancelled'].includes(status)) {
      return new Response('Bad Request', { status: 400 });
    }

    const lockKey = `build_lock:${userId}`;
    const lock = await env.TICKETS.get(lockKey, { type: 'json' });
    await env.TICKETS.delete(lockKey);

    if (lock?.channelId && env.DISCORD_BOT_TOKEN) {
      const message = status === 'success'
        ? `✅ A compilação de **${lock.targetLabel}** terminou. O artefato está disponível no GitHub Actions: ${runUrl}`
        : `❌ A compilação de **${lock.targetLabel}** não foi concluída. Consulte o log: ${runUrl}`;
      await discordRequest(`/channels/${lock.channelId}/messages`, env, {
        method: 'POST',
        body: JSON.stringify({ content: message })
      });
    }

    return new Response('OK');
  } catch (error) {
    console.error('build callback failed', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleCommand(interaction, env) {
  if (interaction.data?.name !== 'setup-ticket') {
    return ephemeral('❌ Este comando não está disponível. Use o painel de tickets configurado pela equipe.');
  }

  if (!isConfiguredTicket(env, interaction)) {
    return ephemeral('❌ Este painel só pode ser configurado no servidor autorizado.');
  }

  const permissions = interaction.member?.permissions;
  const isAdmin = permissions && (BigInt(permissions) & 8n) === 8n;
  if (!isAdmin) {
    return ephemeral('❌ Apenas administradores podem configurar o painel de tickets.');
  }

  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [{
        title: '🎫 Suporte e compilação',
        description: 'Abra um ticket privado para solicitar uma compilação autorizada de Medusa ou Aurora.',
        color: 5814783
      }],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 1,
          label: 'Abrir ticket',
          custom_id: 'abrir_ticket',
          emoji: { name: '🎫' }
        }]
      }]
    }
  });
}

async function handleComponent(interaction, request, env, ctx) {
  if (!isConfiguredTicket(env, interaction)) {
    return ephemeral('❌ Esta interação não pertence ao servidor autorizado.');
  }

  const customId = interaction.data?.custom_id;
  if (customId === 'abrir_ticket') {
    return openTicket(interaction, env, ctx);
  }
  if (customId === 'build_medusa' || customId === 'build_aurora') {
    return startBuild(interaction, request, env, ctx, customId.replace('build_', ''));
  }
  if (customId === 'fechar_ticket') {
    return closeTicket(interaction, env, ctx);
  }

  return ephemeral('❌ Ação desconhecida.');
}

async function openTicket(interaction, env, ctx) {
  const guildId = interaction.guild_id;
  const userId = interactionUserId(interaction);
  if (!userId || !env.DISCORD_BOT_TOKEN) {
    return ephemeral('❌ O bot não está configurado para criar tickets.');
  }

  ctx.waitUntil((async () => {
    try {
      const channels = await discordRequest(`/guilds/${guildId}/channels`, env);
      const activeTickets = channels.filter((channel) => channel.parent_id === env.DISCORD_TICKET_CATEGORY_ID);
      const alreadyOpen = activeTickets.some((channel) => channel.permission_overwrites?.some((overwrite) => overwrite.id === userId));
      if (alreadyOpen) {
        await updateInteractionMessage(interaction, '❌ Você já possui um ticket aberto.', env);
        return;
      }

      const counter = Number(await env.TICKETS.get('ticket_counter') || '0') + 1;
      await env.TICKETS.put('ticket_counter', String(counter));
      const channel = await discordRequest(`/guilds/${guildId}/channels`, env, {
        method: 'POST',
        body: JSON.stringify({
          name: `compilar-${counter}`,
          type: 0,
          parent_id: env.DISCORD_TICKET_CATEGORY_ID,
          permission_overwrites: [
            { id: guildId, type: 0, deny: '1024' },
            { id: userId, type: 1, allow: '3072' }
          ]
        })
      });

      await discordRequest(`/channels/${channel.id}/messages`, env, {
        method: 'POST',
        body: JSON.stringify({
          embeds: [{
            title: '🔨 Área de compilação',
            description: `Olá <@${userId}>. Escolha um projeto aprovado para compilar. O bot só executa código do branch protegido de cada repositório.`,
            color: 3447003
          }],
          components: [{
            type: 1,
            components: [
              { type: 2, style: 1, label: 'Compilar Medusa', custom_id: 'build_medusa' },
              { type: 2, style: 1, label: 'Compilar Aurora', custom_id: 'build_aurora' },
              { type: 2, style: 4, label: 'Fechar ticket', custom_id: 'fechar_ticket' }
            ]
          }]
        })
      });

      await updateInteractionMessage(interaction, `✅ Ticket aberto em <#${channel.id}>.`, env);
    } catch (error) {
      console.error('ticket creation failed', error);
      await updateInteractionMessage(interaction, '❌ Não foi possível abrir o ticket. Verifique as permissões do bot.', env);
    }
  })());

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64 }
  });
}

async function startBuild(interaction, request, env, ctx, targetName) {
  const target = getBuildTarget(env, targetName);
  const userId = interactionUserId(interaction);
  if (!target || !userId || !env.GITHUB_TOKEN || !env.BUILD_CALLBACK_SECRET) {
    return ephemeral('❌ A compilação não está configurada. Contate a equipe.');
  }

  const lockKey = `build_lock:${userId}`;
  if (await env.TICKETS.get(lockKey)) {
    return ephemeral('⚠️ Você já possui uma compilação em andamento.');
  }

  await env.TICKETS.put(lockKey, JSON.stringify({
    channelId: interaction.channel_id,
    targetLabel: target.label
  }), { expirationTtl: 3600 });

  const workerUrl = new URL(request.url).origin;
  const dispatchUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${target.repository}/actions/workflows/${env.BUILD_WORKFLOW}/dispatches`;
  ctx.waitUntil(fetch(dispatchUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'supremorpg-discord-build-bot'
    },
    body: JSON.stringify({
      ref: env.BUILD_REF,
      inputs: {
        user_id: userId,
        worker_url: workerUrl
      }
    })
  }).then(async (response) => {
    if (!response.ok) {
      console.error('workflow dispatch failed', response.status);
      await env.TICKETS.delete(lockKey);
    }
  }).catch(async (error) => {
    console.error('workflow dispatch failed', error);
    await env.TICKETS.delete(lockKey);
  }));

  return ephemeral(`💻 A compilação autorizada de **${target.label}** foi iniciada. O ticket receberá o resultado.`);
}

function closeTicket(interaction, env, ctx) {
  ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, 3000)).then(() =>
    discordRequest(`/channels/${interaction.channel_id}`, env, { method: 'DELETE' })
  ));

  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '🔒 Este ticket será fechado em alguns segundos.' }
  });
}

async function updateInteractionMessage(interaction, content, env) {
  return fetch(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

async function discordRequest(path, env, init = {}) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(`Discord API request failed: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function cleanupTickets(env) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID || !env.DISCORD_TICKET_CATEGORY_ID) {
    return;
  }

  try {
    const channels = await discordRequest(`/guilds/${env.DISCORD_GUILD_ID}/channels`, env);
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    for (const channel of channels.filter((item) => item.parent_id === env.DISCORD_TICKET_CATEGORY_ID)) {
      const messages = await discordRequest(`/channels/${channel.id}/messages?limit=1`, env);
      const lastActivity = messages[0] ? new Date(messages[0].timestamp).getTime() : 0;
      if (lastActivity && lastActivity < cutoff) {
        await discordRequest(`/channels/${channel.id}`, env, { method: 'DELETE' });
      }
    }
  } catch (error) {
    console.error('ticket cleanup failed', error);
  }
}
