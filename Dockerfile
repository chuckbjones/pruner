FROM node:14

RUN mkdir -p /usr/src/app && mkdir /data
WORKDIR /usr/src/app

COPY package.json /usr/src/app/
COPY package-lock.json /usr/src/app/
RUN npm install && npm cache clean --force
COPY . /usr/src/app

ENTRYPOINT [ "node", "/usr/src/app/index.js" ]
