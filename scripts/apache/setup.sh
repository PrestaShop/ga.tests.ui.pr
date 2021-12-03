#!/bin/sh

set -x

# Get vars
WORKSPACE=$1
PS_DIR=$2
PHP_VERSION=$3

# Install apache
add-apt-repository ppa:ondrej/php -y
apt update && apt install -y apache2 libapache2-mod-php$PHP_VERSION

# Enable rewrite mode
a2enmod rewrite actions alias

# Copy apache vhost and set Documentroot
cp -f ./scripts/apache/apache-vhost /etc/apache2/sites-available/000-default.conf
sed -e "s?%BUILD_DIR%?$(echo $WORKSPACE/$PS_DIR)?g" --in-place /etc/apache2/sites-available/000-default.conf

# Restart apache after giving permission
chmod 777 -R $WORKSPACE/$PS_DIR/
service apache2 restart
