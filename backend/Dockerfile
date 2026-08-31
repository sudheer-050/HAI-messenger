FROM node:18-alpine
WORKDIR /usr/src/app
# multica CLI -- required by mika-bridge.js for the admin-only Mika chat.
# Official release binary from https://github.com/multica-ai/multica/releases.
# The binary alone isn't enough to authenticate -- see docker-compose.yml's
# read-only bind mount of the host's ~/.multica config for that part (myalien
# dev reuses this PC's own already-logged-in session; production instead
# mounts a dedicated authenticated volume -- see MYAG-130).
RUN wget -q -O /tmp/multica.tar.gz https://github.com/multica-ai/multica/releases/download/v0.4.36/multica-cli-0.4.36-linux-amd64.tar.gz \
    && mkdir -p /tmp/multica-extract \
    && tar -xzf /tmp/multica.tar.gz -C /tmp/multica-extract \
    && find /tmp/multica-extract -type f -name 'multica*' -exec sh -c 'test -x "$1" || chmod +x "$1"; mv "$1" /usr/local/bin/multica' _ {} \; \
    && rm -rf /tmp/multica.tar.gz /tmp/multica-extract \
    && /usr/local/bin/multica --version
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]