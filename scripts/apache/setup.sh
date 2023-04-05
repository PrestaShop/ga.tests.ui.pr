#!/bin/sh

set -x

# Get vars
WORKSPACE=$1
PS_DIR=$2
PHP_VERSION=$3

# Install apache mod_php
apt update && apt install -y libapache2-mod-php$PHP_VERSION

# Enable rewrite mode
a2enmod rewrite actions alias ssl

# Copy apache vhost and set Documentroot
cp -f ./scripts/apache/apache-vhost /etc/apache2/sites-available/000-default.conf
sed -e "s?%BUILD_DIR%?$(echo $WORKSPACE/$PS_DIR)?g" --in-place /etc/apache2/sites-available/000-default.conf
sed -e "s?%MKCERT_DIR%?$(echo $WORKSPACE)?g" --in-place /etc/apache2/sites-available/000-default.conf

# Restart apache after giving permission
chmod 777 -R $WORKSPACE/$PS_DIR/
chmod +x /home/runner/
service apache2 restart
