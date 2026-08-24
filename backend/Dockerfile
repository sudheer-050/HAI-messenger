FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
# NOTE (MYAG-130): the Mika bridge (backend/server.js) shells out to the
# `multica` CLI at runtime, which is NOT installed by this image. Deploying
# with MULTICA_PROJECT_ID/MIKA_AGENT_ID/MIKA_PARENT_ISSUE_ID set requires the
# CLI binary to be installed and authenticated inside this container (or on
# the host, if not run in Docker) as a scoped service identity beforehand --
# this is a manual operational step outside this repo, not something this
# Dockerfile can safely automate (it needs real, non-committable credentials).
# Without it the endpoint self-disables (503) and the rest of the app is fine.
CMD ["npm", "start"]