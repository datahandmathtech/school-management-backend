git add .
git commit -m "feat: Backend setup with latest changes and dist"
git branch -M main
git remote remove origin
git remote add origin https://github.com/datahandmathtech/school-management-backend.git
git push -u origin main -f
