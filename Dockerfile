FROM node:22

RUN mkdir -p /usr/src/app \
  && mkdir /config \
  && mkdir /storage

WORKDIR /usr/src/app

COPY package.json /usr/src/app/
COPY package-lock.json /usr/src/app/
RUN npm install && npm cache clean --force

COPY . /usr/src/app

ENTRYPOINT [ "node", "/usr/src/app/index.js", "/config/config.yaml" ]
