FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
# AI Mode shells out to the Claude Code CLI (authenticated via CLAUDE_CODE_OAUTH_TOKEN,
# see `claude setup-token`) instead of a separate pay-per-token API key.
RUN npm install -g @anthropic-ai/claude-code
COPY . .
EXPOSE 3000
CMD ["npm", "start"]