FROM node:25.3.0-alpine3.23

WORKDIR /usr/src/app

COPY . .
RUN yarn
EXPOSE 8080
RUN yarn build

CMD ["yarn", "start:prod"]
